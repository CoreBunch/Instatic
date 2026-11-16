/**
 * Shared SQL + coercion helpers used by multiple dashboard widget readers.
 *
 * Anything in this module is consumed by 2+ readers. One-reader helpers
 * stay co-located in their reader's file so the call site is obvious and
 * the surface here doesn't bloat into a junk drawer.
 *
 *   • `coerceCount`             — every reader that calls `count(*)`
 *   • `coerceBytes`             — Media, Storage
 *   • `buildRowPath`            — Publish lineup, Activity
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

/**
 * Build the public path for a content row from its table's route_base
 * and the row's slug. Shared by the Publish lineup and Activity widgets
 * so both render the same `/blog/<slug>` style label.
 *
 *   • Falls back to `/${tableId}/<slug>` when route_base is missing
 *     (collection still being set up, or a system table without a
 *     route prefix yet).
 *   • An empty slug renders as the literal `(no slug)` placeholder so
 *     the row stays clickable in the widget instead of dropping a
 *     trailing slash that looks like a broken link.
 */
export function buildRowPath(routeBase: string | null, tableId: string, slug: string): string {
  const safeSlug = slug || '(no slug)'
  const base = routeBase && routeBase.trim().length > 0 ? routeBase : `/${tableId}`
  const normalizedBase = base.startsWith('/') ? base : `/${base}`
  const trimmedBase = normalizedBase.endsWith('/') ? normalizedBase.slice(0, -1) : normalizedBase
  return `${trimmedBase}/${safeSlug}`
}
