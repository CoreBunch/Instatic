/**
 * Cross-table content search (spotlight content provider).
 *
 *   searchDataRows — search non-deleted rows across all non-deleted data
 *                    tables by slug, returning a lightweight summary
 */
import { placeholder, type DbClient } from '../../../db/client'
import type { DataRowStatus } from '@core/data/schemas'
import { isoDate } from '@core/utils/isoDate'
import { getDefaultLocale, resolveContentLocale } from '../../localization'

/**
 * A lightweight row summary returned by spotlight content search.
 * Omits user references and cells to keep the response small.
 */
interface DataRowSearchResult {
  id: string
  tableId: string
  tableSlug: string
  tableName: string
  slug: string
  status: DataRowStatus
  updatedAt: string
  /** The row's table family — the handler drops rows the caller cannot read. */
  tableSystem: boolean
}

interface DataRowSearchRow {
  id: string
  table_id: string
  table_slug: string
  table_name: string
  table_system: number | boolean
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_at: string | Date
}

interface SearchDataRowsVisibility {
  tableSlugs?: readonly string[]
  localeId?: string
  /**
   * When set, only rows whose effective owner matches this user id are
   * returned. Ownership follows the same rule used by `listDataRows`:
   * `authorUserId` wins when present, otherwise `createdByUserId` is the
   * effective owner. Pass `null` (or omit) for callers who can see every
   * row (`content.edit.any` / `content.publish.any` / `content.manage`).
   */
  ownerUserId?: string | null
}

/**
 * Search non-deleted rows across all non-deleted data tables by slug.
 * The slug is a URL-safe, lowercased derivative of the content title,
 * making it a reliable text proxy for search without requiring dialect-
 * specific JSON extraction from cells_json.
 *
 * `visibility.ownerUserId` restricts the result set to rows owned by the
 * caller — required for `content.edit.own`-only roles so a slug fragment
 * typed in spotlight can't surface other authors' row metadata. Callers
 * with broad visibility (`canSeeAllDataRows`) should omit the filter.
 *
 * Both `lower()` and `LIKE` are ANSI SQL — safe for Postgres and SQLite.
 */
export async function searchDataRows(
  db: DbClient,
  query: string,
  limit: number,
  visibility: SearchDataRowsVisibility = {},
): Promise<DataRowSearchResult[]> {
  const sourceLocale = await getDefaultLocale(db)
  const locale = visibility.localeId === undefined ? sourceLocale : await resolveContentLocale(db, visibility.localeId)
  if (visibility.tableSlugs?.length === 0) return []
  const params: unknown[] = []
  const bind = (value: unknown) => { params.push(value); return placeholder(db.dialect, params.length) }
  const selectedLocale = bind(locale.id)
  const source = bind(sourceLocale.id)
  const search = bind(`%${query.toLowerCase()}%`)
  const ownerFilter = visibility.ownerUserId ? `and coalesce(data_rows.author_user_id, data_rows.created_by_user_id) = ${bind(visibility.ownerUserId)}` : ''
  const tableFilter = visibility.tableSlugs ? `and data_tables.slug in (${visibility.tableSlugs.map(bind).join(', ')})` : ''
  const boundedLimit = bind(limit)
  const { rows } = await db.unsafe<DataRowSearchRow>(`
    select data_rows.id,
           data_rows.table_id,
           coalesce(localized.slug, source.slug, '') as slug,
           case when localized.availability = 'online' and localized.active_version_id is not null then 'published'
                when localized.scheduled_publish_at is not null then 'scheduled'
                when localized.active_version_id is not null then 'unpublished' else 'draft' end as status,
           data_rows.author_user_id,
           data_rows.created_by_user_id,
           data_rows.updated_at,
           data_tables.slug as table_slug,
           data_tables.name as table_name,
           data_tables.system as table_system
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    left join data_row_localizations localized on localized.row_id = data_rows.id and localized.locale_id = ${selectedLocale}
    left join data_row_localizations source on source.row_id = data_rows.id and source.locale_id = ${source}
    where data_rows.deleted_at is null
      and data_tables.deleted_at is null
      and lower(coalesce(localized.slug, source.slug, '')) like ${search}
      ${ownerFilter}
      ${tableFilter}
    order by data_rows.updated_at desc
    limit ${boundedLimit}
  `, params)
  const results = rows.map((r) => ({
    row: r,
    result: {
      id: r.id,
      tableId: r.table_id,
      tableSlug: r.table_slug,
      tableName: r.table_name,
      slug: r.slug,
      status: r.status,
      updatedAt: isoDate(r.updated_at),
      tableSystem: Boolean(r.table_system),
    },
  }))
  return results.map(({ result }) => result)
}
