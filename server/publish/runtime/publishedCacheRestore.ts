/**
 * Restores a runtime package cache entry that a live published page still
 * points at but that is no longer on disk.
 *
 * Publish installs the site's locked packages and bakes URLs of the form
 * `/_instatic/runtime/cache/<hash>/...` into the published importmap. Nothing
 * re-runs that install afterwards, so a cache directory lost after publish (a
 * recreated container, a restored database on a fresh disk, a cleaned folder,
 * an upgrade that moved the default location) would leave every one of those
 * URLs 404 until someone republished. `packageServer.ts` calls this on a miss
 * instead: the hash is traced back to the published lock that produced it and
 * `ensureRuntimeDependencyCache` reinstalls it.
 *
 * Only a lock that is published right now can be restored. An unknown hash
 * costs one query per `LOCK_LOOKUP_TTL_MS` and installs nothing, so the public URL cannot be used to
 * make the server install arbitrary packages.
 */
import { normalizeSiteRuntimeConfig, type SiteDependencyLock } from '@core/site-runtime'
import type { DbClient } from '../../db'
import { getLivePublishedSiteByImportmapFragment } from '../../repositories/publish'
import {
  ensureRuntimeDependencyCache,
  runtimeDependencyLockHash,
  type RuntimeInstallRunner,
} from './dependencyCache'
import { RUNTIME_PACKAGE_PREFIX } from './packageServer'

/**
 * How long a failed reinstall is remembered. Without it every visitor request
 * for a package would spawn another `bun install` while the registry is down.
 */
const FAILED_RESTORE_RETRY_MS = 30_000

/**
 * How long the answer to "which live lock owns this hash" is remembered,
 * including "none". The URL is public, so without this every request for a
 * missing file (an unknown hash, or a wrong path under a live one) would run
 * the lookup query again.
 */
const LOCK_LOOKUP_TTL_MS = 30_000

/** Bounds both memories; hashes come from request URLs. */
const MAX_REMEMBERED_HASHES = 256

const failedRestores = new Map<string, number>()
const lockLookups = new Map<string, { lock: SiteDependencyLock | null; at: number }>()

function remember<V>(memory: Map<string, V>, hash: string, value: V): void {
  if (memory.size >= MAX_REMEMBERED_HASHES) memory.clear()
  memory.set(hash, value)
}

/** The lock of a live publish whose cache entry is `hash`, or null. */
async function livePublishedLock(
  db: DbClient,
  hash: string,
  clock: () => number,
): Promise<SiteDependencyLock | null> {
  const remembered = lockLookups.get(hash)
  if (remembered && clock() - remembered.at < LOCK_LOOKUP_TTL_MS) return remembered.lock

  const site = await getLivePublishedSiteByImportmapFragment(db, `${RUNTIME_PACKAGE_PREFIX}${hash}/`)
  const candidate = site ? normalizeSiteRuntimeConfig(site.runtime).dependencyLock : null
  // The lookup is a `like` match on the importmap text; the lock itself has
  // the final word on whether this is the entry the URL names.
  const lock = candidate && runtimeDependencyLockHash(candidate) === hash ? candidate : null
  remember(lockLookups, hash, { lock, at: clock() })
  return lock
}

interface RestorePublishedRuntimeCacheOptions {
  cacheRoot?: string
  runInstall?: RuntimeInstallRunner
  /** Clock override. Mainly for tests. */
  now?: () => number
}

/**
 * Reinstall the cache entry for `hash` when a live publish uses it. Resolves
 * to true when the entry is usable afterwards, false when no live publish
 * owns the hash or the install failed (logged, and not retried for
 * `FAILED_RESTORE_RETRY_MS`).
 */
export async function restorePublishedRuntimeCache(
  db: DbClient,
  hash: string,
  options: RestorePublishedRuntimeCacheOptions = {},
): Promise<boolean> {
  const clock = options.now ?? Date.now
  const failedAt = failedRestores.get(hash)
  if (failedAt !== undefined && clock() - failedAt < FAILED_RESTORE_RETRY_MS) return false

  const lock = await livePublishedLock(db, hash, clock)
  if (!lock) return false

  try {
    await ensureRuntimeDependencyCache(lock, {
      cacheRoot: options.cacheRoot,
      runInstall: options.runInstall,
    })
    failedRestores.delete(hash)
    return true
  } catch (err) {
    console.error('[runtime dependency cache] restoring a published entry failed:', err)
    remember(failedRestores, hash, clock())
    return false
  }
}
