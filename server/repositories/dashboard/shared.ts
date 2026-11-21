/**
 * Shared SQL + coercion helpers used by multiple dashboard widget readers.
 *
 * Anything in this module is consumed by 2+ readers. One-reader helpers
 * stay co-located in their reader's file so the call site is obvious and
 * the surface here doesn't bloat into a junk drawer.
 *
 *   • `coerceCount`             — every reader that calls `count(*)`
 *   • `coerceBytes`             — Media, Storage
 */

/**
 * Coerce a SQL `count(*)` result into a plain JS number. Postgres returns
 * BIGINT counts as strings; SQLite returns them as numbers; both can be
 * `null` when the query had no rows. This helper collapses all three
 * shapes to `number` with a 0 default so callers don't need to repeat the
 * triple-typeof dance.
 */
export function coerceCount(raw: number | string | null | undefined): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === 'string') return parseInt(raw, 10) || 0
  return raw
}

/**
 * Coerce a SQL `sum(...)` byte total into a plain JS number. Same shape
 * as {@link coerceCount} — Postgres BIGINT sums come back as strings,
 * SQLite returns numbers, both can be `null` for an empty set. Aliased
 * separately so call sites read as "this is a byte count" at a glance.
 */
export const coerceBytes = coerceCount
