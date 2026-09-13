/**
 * Shared version-number allocation for `data_row_versions`.
 *
 * Every new version of a data row — whether written by the per-row publish
 * path (`data/publish.ts`) or the whole-site publish pipeline
 * (`repositories/publish.ts`) — allocates its `version_number` through this
 * single function so the "next = max(existing) + 1" invariant has one home.
 */

import type { DbClient } from '../../db/client'
import { isoDate } from '@core/utils/isoDate'

/**
 * Next `version_number` for a row: `max(existing) + 1`, or `1` when the row has
 * no versions yet. Dialect-naive ANSI SQL — `coalesce` + `max`, no Postgres-isms.
 */
export async function nextDataRowVersionNumber(db: DbClient, rowId: string): Promise<number> {
  const { rows } = await db<{ next_version: number }>`
    select coalesce(max(version_number), 0) + 1 as next_version
    from data_row_versions
    where row_id = ${rowId}
  `
  return Number(rows[0]?.next_version ?? 1)
}

export interface DataRowVersionSummary {
  id: string
  rowId: string
  versionNumber: number
  slug: string
  publishedAt: string
  publishedByUserId: string | null
  publishedByName: string | null
}

interface DataRowVersionSummaryRow {
  id: string
  row_id: string
  version_number: number
  slug: string
  published_at: string | Date
  published_by_user_id: string | null
  published_by_name: string | null
  published_by_email: string | null
}

/**
 * Every published version of a row, newest first. Versions are recorded by
 * publishes on main, so `rowId` is the row's logical id — which is also its
 * physical id there.
 */
export async function listDataRowVersions(db: DbClient, rowId: string): Promise<DataRowVersionSummary[]> {
  const { rows } = await db<DataRowVersionSummaryRow>`
    select data_row_versions.id,
           data_row_versions.row_id,
           data_row_versions.version_number,
           data_row_versions.slug,
           data_row_versions.published_at,
           data_row_versions.published_by_user_id,
           users.display_name as published_by_name,
           users.email as published_by_email
    from data_row_versions
    left join users on users.id = data_row_versions.published_by_user_id
    where data_row_versions.row_id = ${rowId}
    order by data_row_versions.version_number desc
  `
  return rows.map((row) => ({
    id: row.id,
    rowId: row.row_id,
    versionNumber: Number(row.version_number),
    slug: row.slug,
    publishedAt: isoDate(row.published_at),
    publishedByUserId: row.published_by_user_id,
    publishedByName: row.published_by_name || row.published_by_email || null,
  }))
}

export interface DataRowVersionContent {
  id: string
  rowId: string
  versionNumber: number
  cells: Record<string, unknown>
  slug: string
}

/** One version's stored content, or null when the id is unknown or belongs to another row. */
export async function getDataRowVersion(
  db: DbClient,
  rowId: string,
  versionId: string,
): Promise<DataRowVersionContent | null> {
  const { rows } = await db<{ id: string; row_id: string; version_number: number; cells_json: Record<string, unknown>; slug: string }>`
    select id, row_id, version_number, cells_json, slug
    from data_row_versions
    where id = ${versionId}
      and row_id = ${rowId}
    limit 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    rowId: row.row_id,
    versionNumber: Number(row.version_number),
    cells: row.cells_json,
    slug: row.slug,
  }
}
