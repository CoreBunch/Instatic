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
 * The URL is public, so the lookup must not cost a database query per
 * request. The set of hashes the live importmaps reference is read once per
 * publish version (`createVersionedSingleFlight`, invalidated by
 * `bumpPublishVersion`) and every later miss is answered from that set. An
 * unknown hash is a 404 from memory: it never queries the database and never
 * installs anything, so the URL cannot be used to scan tables or to make the
 * server install arbitrary packages. Everything remembered per hash lives on
 * that index, so it only ever holds hashes a live publish uses and requests
 * for other hashes cannot evict it.
 */
import { normalizeSiteRuntimeConfig, type SiteDependencyLock } from '@core/site-runtime'
import type { DbClient } from '../../db'
import { getSiteSnapshotDocument, listLivePublishedImportmaps } from '../../repositories/publish'
import { createVersionedSingleFlight, getPublishVersion } from '../publishState'
import {
  ensureRuntimeDependencyCache,
  runtimeDependencyLockHash,
  type RuntimeInstallRunner,
} from './dependencyCache'

/**
 * How long a failed reinstall is remembered. Without it every visitor request
 * for a package would spawn another `bun install` while the registry is down.
 */
const FAILED_RESTORE_RETRY_MS = 30_000

/** Cache entry hashes as they appear in a published importmap URL. */
const IMPORTMAP_HASH_PATTERN = /\/_instatic\/runtime\/cache\/([0-9a-f]{24})\//g

/** One hash a live importmap references. */
interface LiveCacheEntry {
  /** Newest live snapshot whose importmap names the hash. */
  snapshotId: string
  /**
   * The lock behind the hash, once read from the snapshot: `null` when the
   * snapshot's lock does not hash to it. Read at most once per index.
   */
  lock?: Promise<SiteDependencyLock | null>
  /** When the last reinstall failed. */
  failedAt?: number
}

/** Every cache hash the live publishes reference, for one publish version. */
type LiveCacheIndex = Map<string, LiveCacheEntry>

const liveIndex = createVersionedSingleFlight<LiveCacheIndex>()

async function loadLiveCacheIndex(db: DbClient): Promise<LiveCacheIndex> {
  const index: LiveCacheIndex = new Map()
  // Newest first, so the first snapshot to name a hash wins.
  for (const { snapshotId, importmapBody } of await listLivePublishedImportmaps(db)) {
    for (const match of importmapBody.matchAll(IMPORTMAP_HASH_PATTERN)) {
      if (!index.has(match[1])) index.set(match[1], { snapshotId })
    }
  }
  return index
}

async function lockForEntry(db: DbClient, hash: string, entry: LiveCacheEntry): Promise<SiteDependencyLock | null> {
  entry.lock ??= getSiteSnapshotDocument(db, entry.snapshotId).then((site) => {
    const candidate = site ? normalizeSiteRuntimeConfig(site.runtime).dependencyLock : null
    // The importmap only names the hash; the lock has the final word on
    // whether it is the entry the URL asks for.
    return candidate && runtimeDependencyLockHash(candidate) === hash ? candidate : null
  }).catch((err: unknown) => {
    // A failed read is not an answer; let the next request ask again.
    entry.lock = undefined
    throw err
  })
  return entry.lock
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
  const index = await liveIndex.get(getPublishVersion(), () => loadLiveCacheIndex(db))
  const entry = index?.get(hash)
  if (!entry) return false
  if (entry.failedAt !== undefined && clock() - entry.failedAt < FAILED_RESTORE_RETRY_MS) return false

  const lock = await lockForEntry(db, hash, entry)
  if (!lock) return false

  try {
    await ensureRuntimeDependencyCache(lock, {
      cacheRoot: options.cacheRoot,
      runInstall: options.runInstall,
    })
    entry.failedAt = undefined
    return true
  } catch (err) {
    console.error('[runtime dependency cache] restoring a published entry failed:', err)
    entry.failedAt = clock()
    return false
  }
}
