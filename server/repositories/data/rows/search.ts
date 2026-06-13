/**
 * Cross-table content search (spotlight content provider).
 *
 *   searchDataRows — search non-deleted rows across all non-deleted data
 *                    tables by slug, returning a lightweight summary
 */
import type { DbClient } from '../../../db/client'
import type { DataRowStatus } from '@core/data/schemas'
import { isoDate } from '@core/utils/isoDate'

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
}

interface DataRowSearchRow {
  id: string
  table_id: string
  table_slug: string
  table_name: string
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_at: string | Date
}

interface SearchDataRowsVisibility {
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
  const likePattern = `%${query.toLowerCase()}%`
  const { rows } = await db<DataRowSearchRow>`
    select data_rows.id,
           data_rows.table_id,
           data_rows.slug,
           data_rows.status,
           data_rows.author_user_id,
           data_rows.created_by_user_id,
           data_rows.updated_at,
           data_tables.slug as table_slug,
           data_tables.name as table_name
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.deleted_at is null
      and data_tables.deleted_at is null
      and lower(data_rows.slug) like ${likePattern}
    order by data_rows.updated_at desc
    limit ${limit}
  `
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
    },
  }))
  if (visibility.ownerUserId) {
    const ownerUserId = visibility.ownerUserId
    return results
      .filter(({ row }) => {
        if (row.author_user_id === ownerUserId) return true
        if (row.author_user_id === null) return row.created_by_user_id === ownerUserId
        return false
      })
      .map(({ result }) => result)
  }
  return results.map(({ result }) => result)
}
