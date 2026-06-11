/**
 * In-memory LRU render cache for Layer B of the publishing architecture.
 *
 * Cache key: (urlPath, queryString) joined with a NUL separator to avoid
 * collisions. Each stored entry remembers the publishVersion it was created
 * at; a read whose stored version differs from the current version is treated
 * as a miss and the entry is replaced lazily.
 *
 * Size is capped by RENDER_CACHE_MAX_ENTRIES (env var, parsed at module init,
 * default 1000). LRU recency is maintained via Map insertion order: on a hit
 * the entry is deleted + re-inserted to move it to the most-recent position;
 * on an insert when at capacity the first key (least-recently-used) is evicted.
 *
 * Single-flight: concurrent callers for the same key share one in-flight
 * factory promise so the factory runs exactly once per concurrent burst. The
 * in-flight slot is cleared in a `finally` block so a rejection also cleans up.
 *
 * `null` factory returns are not cached — subsequent calls re-invoke the
 * factory. Factory errors propagate to all concurrent callers sharing the
 * in-flight promise.
 *
 * Version is captured at render START: an entry is stored tagged with the
 * publishVersion that was current when the factory began, and ONLY if the
 * version is unchanged when the factory resolves. A publish that lands
 * mid-render (bumping the version) means the rendered HTML reflects a
 * superseded snapshot, so it is discarded rather than cached as current —
 * the next request re-renders against the fresh snapshot.
 *
 * The publish version, publish lock, and the version-keyed single-flight
 * primitive live in `publishState.ts` — this module is purely the LRU and
 * reads the version from there for its staleness check.
 */

import { getPublishVersion, resetPublishStateForTests } from './publishState'

export interface RenderCacheKey {
  urlPath: string
  queryString: string
}

export interface CachedResponse {
  body: string
  headers: Record<string, string>
  status: 200
}

interface CacheEntry {
  publishVersion: number
  response: CachedResponse
}

// Parse max entries from env on module init. Fall back to 1000 on
// invalid/non-positive int.
let maxEntries: number = (() => {
  const raw = process.env.RENDER_CACHE_MAX_ENTRIES
  if (!raw) return 1000
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 1000
})()

let hits = 0
let misses = 0

// LRU map: Map iteration order is insertion order → oldest entry is first.
const map = new Map<string, CacheEntry>()

// Single-flight: tracks in-progress factory promises by cache key.
const inFlight = new Map<string, Promise<CachedResponse | null>>()

function cacheKey(key: RenderCacheKey): string {
  return `${key.urlPath}\0${key.queryString}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return current cache statistics. Useful for observability and tests. */
export function getStats(): { hits: number; misses: number; size: number } {
  return { hits, misses, size: map.size }
}

/**
 * Reset all cache state. For use in tests only.
 *
 * Clears the LRU map, the in-flight map, and hit/miss counters, then delegates
 * to `resetPublishStateForTests()` so the publish version, the publish lock,
 * and every version-keyed single-flight memo reset together — one call gives a
 * test a fully clean slate.
 */
export function resetForTests(): void {
  map.clear()
  inFlight.clear()
  hits = 0
  misses = 0
  resetPublishStateForTests()
}

/**
 * Override the maximum-entries cap. For use in tests only.
 *
 * Call before `resetForTests` to set a smaller cap for eviction tests.
 * The change persists until the next call to this function.
 */
export function __setMaxEntriesForTests(n: number): void {
  maxEntries = n
}

/**
 * Return the cached response for `key` if one exists at the current publish
 * version, WITHOUT invoking any factory. A hit promotes the entry (LRU) and
 * counts toward the hit statistic; a miss counts nothing — the caller is
 * expected to follow up with `getOrRender`, which records the miss.
 *
 * This is the request fast-path: `renderPublicResolution` peeks BEFORE doing
 * route resolution, so a warm dynamic route skips its DB round-trips and the
 * full-site snapshot parse entirely. Safe because every mutation that changes
 * what a published URL serves — full publish, incremental row publish,
 * unpublish, soft-delete, table move — bumps the publish version, which makes
 * every cached entry miss here.
 */
export function peek(key: RenderCacheKey): CachedResponse | null {
  const k = cacheKey(key)
  const existing = map.get(k)
  if (existing !== undefined && existing.publishVersion === getPublishVersion()) {
    // LRU promotion: delete + re-set moves the entry to most-recent position.
    map.delete(k)
    map.set(k, existing)
    hits++
    return existing.response
  }
  return null
}

/**
 * Return a cached response for `key`, invoking `factory` only on a miss.
 *
 * Hit: entry exists and its publishVersion matches the current version.
 * Miss: entry absent, version mismatch, or currently in-flight.
 *
 * On a miss, if another caller already started the factory for this key, the
 * current caller awaits the same promise (single-flight). The factory is
 * otherwise invoked once and its result cached (unless the result is null).
 *
 * `null` factory results are not cached. Factory errors propagate to the
 * caller (and to all concurrent callers sharing the in-flight promise).
 */
export async function getOrRender(
  key: RenderCacheKey,
  factory: () => Promise<CachedResponse | null>,
): Promise<CachedResponse | null> {
  const k = cacheKey(key)
  const currentVersion = getPublishVersion()

  // LRU lookup — valid only when publishVersion matches.
  const existing = map.get(k)
  if (existing !== undefined && existing.publishVersion === currentVersion) {
    // LRU promotion: delete + re-set moves the entry to most-recent position.
    map.delete(k)
    map.set(k, existing)
    hits++
    return existing.response
  }

  // Miss — this call must either join an in-flight promise or start the factory.
  misses++

  // Single-flight: join an existing in-flight promise rather than starting
  // a second factory for the same key.
  const inflight = inFlight.get(k)
  if (inflight !== undefined) {
    return inflight
  }

  // Capture the publish version at render START. The factory renders the
  // snapshot that was current now; if a publish bumps the version while the
  // render is in flight, the result is stale and must NOT be cached as the new
  // version (that would serve old HTML as current until the next publish).
  const versionAtStart = currentVersion

  // Start a new factory and register it as in-flight.
  const promise: Promise<CachedResponse | null> = (async () => {
    try {
      const result = await factory()
      // Only cache when a publish did NOT happen mid-render. A version change
      // means `result` reflects a now-superseded snapshot — drop it and let the
      // next request re-render against the fresh snapshot.
      if (result !== null && getPublishVersion() === versionAtStart) {
        // Remove any stale entry for this key so the new one lands at the
        // most-recent (tail) position in the Map's insertion order.
        map.delete(k)
        // Evict the least-recently-used entry when at capacity.
        if (map.size >= maxEntries) {
          const firstKey = map.keys().next().value
          if (firstKey !== undefined) map.delete(firstKey)
        }
        map.set(k, { publishVersion: versionAtStart, response: result })
      }
      return result
    } finally {
      inFlight.delete(k)
    }
  })()

  inFlight.set(k, promise)
  return promise
}
