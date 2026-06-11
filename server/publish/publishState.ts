/**
 * Publish-time process state for the publishing pipeline.
 *
 * This module owns the three pieces of cross-request publish state that are
 * NOT the render-cache LRU itself:
 *
 *   1. `publishVersion` — the monotonic counter bumped on every publish commit.
 *      `renderCache` reads it for staleness; Layer C hole placeholders stamp it;
 *      the hole endpoint compares against it. Repositories bump it after a
 *      publish/unpublish.
 *   2. `withPublishLock` — the in-process serializer that prevents two
 *      publishes' read-version → bake → bump-version windows from overlapping
 *      (ISS-038).
 *   3. `createVersionedSingleFlight` — a generalized version-keyed single-flight
 *      memo. One concurrent loader runs per version; the resolved value is
 *      cached until the version changes. Used by the render cache's siblings
 *      (e.g. the hole endpoint's published-snapshot memo) so none of them have
 *      to hand-roll their own module-level cache + in-flight pair + test reset.
 *
 * Keeping this out of `renderCache.ts` removes the repository → render-cache
 * coupling (repositories only need the version + the lock, not the LRU) and
 * gives every version-keyed memo one shared reset hook for tests.
 */

// ---------------------------------------------------------------------------
// Publish version
// ---------------------------------------------------------------------------

let publishVersion = 0

/**
 * Increment the publish version. All version-keyed caches (the render-cache
 * LRU, every `createVersionedSingleFlight` memo) treat their entries as stale
 * on the next read once the version moves.
 *
 * Call after every publish commit (full publish, per-row publish, unpublish).
 */
export function bumpPublishVersion(): number {
  return ++publishVersion
}

/**
 * Return the current publish version. Used by Layer C hole placeholders
 * (`data-instatic-version`), the hole endpoint to detect stale requests, and
 * the render cache for its staleness check.
 */
export function getPublishVersion(): number {
  return publishVersion
}

/**
 * Bump the publish version under the publish lock. The serialization matters
 * (ISS-038): a bare bump racing a publish's read-version → bake → bump window
 * would mis-stamp its baked hole shells as permanently stale. Call this from
 * every content mutation that retracts or moves a published route outside a
 * publish — unpublish, soft-delete, table move — so the render cache and the
 * versioned snapshot memos stop serving the retracted route.
 *
 * NEVER call inside an open DB transaction: the publish lock may be held by a
 * publish that is itself queued behind the transaction chain (deadlock).
 */
export function bumpPublishVersionSerialized(): Promise<void> {
  return withPublishLock(async () => { bumpPublishVersion() })
}

// ---------------------------------------------------------------------------
// Publish serialization
// ---------------------------------------------------------------------------

let publishChain: Promise<unknown> = Promise.resolve()

/**
 * Run a publish operation under a single in-process lock so no two publishes'
 * read-version → bake → bump-version windows overlap (ISS-038). Without this,
 * two concurrent publishes both read version N, stamp every `<instatic-hole>`
 * shell with N+1, then each bump independently to N+2 — leaving baked shells
 * permanently mis-stamped (the hole endpoint serves them as stale). The lock
 * also serializes the two-slot artefact swap. JS is single-threaded, so a
 * promise-chain serializer is sufficient.
 */
export function withPublishLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => fn()
  const result = publishChain.then(run, run)
  publishChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

// ---------------------------------------------------------------------------
// Version-keyed single-flight memo
// ---------------------------------------------------------------------------

/** A version-keyed single-flight memo created by `createVersionedSingleFlight`. */
export interface VersionedSingleFlight<T> {
  /**
   * Return the memoised value for `version`, invoking `load` only on a miss.
   *
   * Hit: a value cached at exactly `version` exists → returned without I/O.
   * Miss: no value (or a value for a different version) → `load` runs. Two
   * concurrent callers at the same version share one `load` invocation; the
   * resolved value is cached for that version. A `null` result is NOT cached
   * (the next call re-invokes `load`); a rejection clears the in-flight slot.
   */
  get(version: number, load: () => Promise<T | null>): Promise<T | null>
  /** Drop the cached value and any in-flight load. Tests only. */
  reset(): void
}

// Every memo registers its reset here so `resetPublishStateForTests` can clear
// them all in one call — no module needs to export a bespoke reset hook.
const versionedCacheResets: Array<() => void> = []

/**
 * Register a reset callback with the shared test-reset list so
 * `resetPublishStateForTests()` clears this cache too.
 *
 * `createVersionedSingleFlight` uses this for its own reset. Version-keyed
 * caches that are NOT single-flights — e.g. the synchronous page-invariant
 * CSS-bundle memo in `siteCssBundle.ts` — register here directly so they share
 * the one reset hook instead of exporting a bespoke one.
 */
export function registerVersionedCacheReset(reset: () => void): void {
  versionedCacheResets.push(reset)
}

/**
 * Create a generalized version-keyed single-flight memo. See
 * `VersionedSingleFlight` for the contract. Each memo registers its reset with
 * the shared test-reset list, so `resetPublishStateForTests()` clears it.
 */
export function createVersionedSingleFlight<T>(): VersionedSingleFlight<T> {
  let cache: { version: number; value: T } | null = null
  let inFlight: { version: number; promise: Promise<T | null> } | null = null

  const reset = (): void => {
    cache = null
    inFlight = null
  }
  registerVersionedCacheReset(reset)

  return {
    get(version, load) {
      if (cache && cache.version === version) return Promise.resolve(cache.value)
      if (inFlight && inFlight.version === version) return inFlight.promise

      const promise = (async (): Promise<T | null> => {
        try {
          const value = await load()
          // Cache only non-null results, tagged with the version they loaded
          // for. A version bump mid-load means the next caller misses and
          // reloads against the fresh version.
          if (value !== null) cache = { version, value }
          return value
        } finally {
          if (inFlight && inFlight.version === version) inFlight = null
        }
      })()

      inFlight = { version, promise }
      return promise
    },
    reset,
  }
}

// ---------------------------------------------------------------------------
// Test reset
// ---------------------------------------------------------------------------

/**
 * Reset all publish-time process state: the publish version (to 0), the
 * publish lock chain, and every `createVersionedSingleFlight` memo. For use in
 * tests only. `renderCache.resetForTests()` delegates here so a single call
 * gives a test a clean slate across the cache, the version, and the memos.
 */
export function resetPublishStateForTests(): void {
  publishVersion = 0
  publishChain = Promise.resolve()
  for (const reset of versionedCacheResets) reset()
}
