/**
 * Shared SQL + coercion helpers used by multiple dashboard widget readers.
 *
 * Anything in this module is consumed by 2+ readers. One-reader helpers
 * stay co-located in their reader's file so the call site is obvious and
 * the surface here doesn't bloat into a junk drawer.
 *
 *   • `readStatusCounts`        — Pages, Posts
 *   • `readPublishedSinceCount` — Pages (Posts uses the histogram instead)
 *   • `coerceCount`             — every reader that calls `count(*)`
 *   • `coerceBytes`             — Media, Storage
 *   • `draftContentPath`            — Publish lineup, Activity
 */
import { buildLocalizedPath, LocalizedRouteError } from '@core/localization-routing'
import type { DataRow, DataTable } from '@core/data/schemas'
import type { Locale } from '@core/localization-schema'
import type { DbClient } from '../../../db/client'

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

/** Logical content totals and independent authored language states. A live variant can also be scheduled. */
export async function readStatusCounts(db: DbClient, tableId: string) {
  const { rows } = await db<{
    total: number | string; variants: number | string; published: number | string;
    drafts: number | string; offline: number | string; scheduled: number | string;
  }>`
    select count(distinct r.id) as total, count(l.locale_id) as variants,
      sum(case when l.availability = 'online' and v.id is not null and sl.enabled = true then 1 else 0 end) as published,
      sum(case when l.locale_id is not null and l.active_version_id is null then 1 else 0 end) as drafts,
      sum(case when l.active_version_id is not null and (l.availability = 'offline' or sl.enabled = false) then 1 else 0 end) as offline,
      sum(case when l.scheduled_publish_at is not null then 1 else 0 end) as scheduled
    from data_rows r
    left join data_row_localizations l on l.row_id = r.id
    left join site_locales sl on sl.id = l.locale_id
    left join data_row_versions v on v.id = l.active_version_id and v.row_id = r.id and v.locale_id = l.locale_id
    where r.table_id = ${tableId} and r.deleted_at is null
  `
  const row = rows[0]
  return {
    total: coerceCount(row?.total), variants: coerceCount(row?.variants),
    published: coerceCount(row?.published), drafts: coerceCount(row?.drafts),
    offline: coerceCount(row?.offline), scheduled: coerceCount(row?.scheduled),
  }
}

/** Every locale release in the trailing window counts once, including later replaced versions. */
export async function readPublishedSinceCount(db: DbClient, tableId: string, sinceIso: string): Promise<number> {
  const { rows } = await db<{ count: number | string }>`
    select count(*) as count from data_row_versions v
    join data_rows r on r.id = v.row_id
    where r.table_id = ${tableId} and r.deleted_at is null and v.published_at >= ${sinceIso}
  `
  return coerceCount(rows[0]?.count)
}

/** Invalid or unfinished draft paths have a title in the dashboard, never a fabricated URL. */
export function draftContentPath(locale: Locale, row: Pick<DataRow, 'slug'>, table: DataTable, routeBase?: string): string | null {
  if (!row.slug || (table.kind !== 'page' && table.kind !== 'postType')) return null
  try {
    return buildLocalizedPath(locale, row.slug, table.kind === 'page' ? undefined : (routeBase ?? table.routeBase))
  } catch (error) {
    if (error instanceof LocalizedRouteError) return null
    throw error
  }
}
