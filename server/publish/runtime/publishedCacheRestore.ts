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
 * costs one query and installs nothing, so the public URL cannot be used to
 * make the server install arbitrary packages.
 */
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
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

/** Bounds the failure memory; hashes come from request URLs. */
const MAX_REMEMBERED_FAILURES = 256

const failedRestores = new Map<string, number>()

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

  const site = await getLivePublishedSiteByImportmapFragment(db, `${RUNTIME_PACKAGE_PREFIX}${hash}/`)
  if (!site) return false
  const lock = normalizeSiteRuntimeConfig(site.runtime).dependencyLock
  // The lookup is a `like` match on the importmap text; the lock itself has
  // the final word on whether this is the entry the URL names.
  if (runtimeDependencyLockHash(lock) !== hash) return false

  try {
    await ensureRuntimeDependencyCache(lock, {
      cacheRoot: options.cacheRoot,
      runInstall: options.runInstall,
    })
    failedRestores.delete(hash)
    return true
  } catch (err) {
    console.error('[runtime dependency cache] restoring a published entry failed:', err)
    if (failedRestores.size >= MAX_REMEMBERED_FAILURES) failedRestores.clear()
    failedRestores.set(hash, clock())
    return false
  }
}
