/**
 * Internal mapping + hydrated-read building blocks shared by the data-row
 * query modules.
 *
 *   DataRowRow              — the raw row shape produced by the user-ref joins
 *   selectHydratedDataRows  — runs the canonical "row + four user-ref joins"
 *                             SELECT (the only place that column list lives)
 *                             and maps each row through `mapRow`
 *   mapRow                  — DataRowRow → DataRow domain shape
 *   isOwnedByUser           — effective-owner predicate for visibility filters
 *   placeholder             — re-exported from db/client (the single home) for
 *                             the `db.unsafe()` paths (filter + hydrated select)
 *
 * Nothing here is part of the repository's public surface — the barrel
 * (`./index`) does not re-export this module. Sibling query modules import
 * these helpers directly.
 */
import { placeholder, type DbClient } from '../../../db/client'
import type { DataRow, DataRowCells, DataRowStatus } from '@core/data/schemas'
import { DataUserReferenceSchema } from '@core/data/schemas'
import { parseValue } from '@core/utils/typeboxHelpers'
import { userRefAt, userRefColumns, userRefJoin, type UserJoinColumns } from '../shared'
import { isoDate, isoDateOrNull } from '@core/utils/isoDate'
import { normalizeDataTableFields } from '@core/data/fields'
import { materializeLocalizedCells, resolveDataFieldLocalization } from '@core/localization'
import type { ContentLocalization } from '@core/localization-schema'
import { getDefaultLocale, resolveContentLocale, listContentLocalizations } from '../../localization'

// Re-exported so the sibling rows/ query modules (filter, read) keep one
// local entry point for the dialect-aware placeholder; the single definition
// lives in db/client.
export { placeholder }

// ---------------------------------------------------------------------------
// Input shapes (shared by the single-row and bulk write modules)
// ---------------------------------------------------------------------------

export interface InsertDataRowInput {
  id?: string
  tableId: string
  cells: DataRowCells
  /**
   * Denormalized slug derived from `cells.slug` (when the table has a slug
   * field) by the handler before calling this repo. Pass empty string for
   * tables that have no slug field.
   */
  slug: string
  localeId?: string
}

export interface UpdateDataRowDraftInput {
  cells: DataRowCells
  slug?: string
  localeId?: string
}

// ---------------------------------------------------------------------------
// Raw row shape returned by the hydrated SELECT
// ---------------------------------------------------------------------------

interface DataRowRow extends UserJoinColumns {
  id: string
  table_id: string
  cells_json: Record<string, unknown>
  fields_json: unknown
  slug: string
  status: DataRowStatus
  seq: number
  author_user_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  published_by_user_id: string | null
  created_at: string | Date
  updated_at: string | Date
  published_at: string | Date | null
  scheduled_publish_at: string | Date | null
  deleted_at: string | Date | null
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function mapRow(
  row: DataRowRow,
  localeId: string,
  localization: ContentLocalization | null,
  source: ContentLocalization | null,
  publishedBy: DataRow['publishedBy'],
  publicPath: string | null,
): DataRow {
  const fields = normalizeDataTableFields(row.fields_json)
  let slug = localization?.slug ?? source?.slug ?? ''
  const cells = materializeLocalizedCells(fields, row.cells_json, source?.cells ?? {}, localization?.cells ?? {})
  const slugField = fields.find((field) => field.id === 'slug')
  if (slugField && resolveDataFieldLocalization(slugField) === 'shared') slug = typeof cells.slug === 'string' ? cells.slug : ''
  else if (slugField) cells.slug = slug
  const status: DataRowStatus = localization?.availability === 'online' && localization.activeVersionId
    ? 'published'
    : localization?.scheduledPublishAt
      ? 'scheduled'
      : localization?.activeVersionId ? 'unpublished' : 'draft'
  return {
    id: row.id,
    tableId: row.table_id,
    localeId,
    sharedCells: row.cells_json,
    localization,
    cells,
    slug,
    publicPath,
    status,
    seq: Number(row.seq),
    authorUserId: row.author_user_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    publishedByUserId: localization?.publishedByUserId ?? null,
    author: userRefAt(row, 'author'),
    createdBy: userRefAt(row, 'created_by'),
    updatedBy: userRefAt(row, 'updated_by'),
    publishedBy,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    publishedAt: localization?.publishedAt ?? null,
    scheduledPublishAt: localization?.scheduledPublishAt ?? null,
    deletedAt: isoDateOrNull(row.deleted_at),
  }
}

export function isOwnedByUser(row: DataRow, ownerUserId: string): boolean {
  if (row.authorUserId === ownerUserId) return true
  if (row.authorUserId === null) return row.createdByUserId === ownerUserId
  return false
}

// ---------------------------------------------------------------------------
// Hydrated SELECT (single source of the row + user-ref join column list)
// ---------------------------------------------------------------------------

/**
 * The full hydrated column list, including the four user-ref joins. The
 * `<prefix>_*` alias groups are built from the shared `userRefColumns` fragment
 * (the single source for the user-ref alias set, also spliced by `publish.ts`).
 */
const DATA_ROW_COLUMNS = `data_rows.id,
       data_rows.table_id,
       data_rows.cells_json,
       data_tables.fields_json,
       data_rows.slug,
       data_rows.status,
       data_rows.seq,
       data_rows.author_user_id,
       data_rows.created_by_user_id,
       data_rows.updated_by_user_id,
       data_rows.published_by_user_id,
       ${userRefColumns('author')},
       ${userRefColumns('created_by')},
       ${userRefColumns('updated_by')},
       ${userRefColumns('published_by')},
       data_rows.created_at,
       data_rows.updated_at,
       data_rows.published_at,
       data_rows.scheduled_publish_at,
       data_rows.deleted_at`

/** The `from data_rows` clause with the four user-ref left joins. */
const DATA_ROW_JOINS = `from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    ${userRefJoin('author', 'data_rows.author_user_id')}
    ${userRefJoin('created_by', 'data_rows.created_by_user_id')}
    ${userRefJoin('updated_by', 'data_rows.updated_by_user_id')}
    ${userRefJoin('published_by', 'data_rows.published_by_user_id')}`

/**
 * Shape of a hydrated data-row query. Every clause is spliced verbatim into the
 * canonical "row + four user-ref joins" SELECT, so each must reference columns
 * only and bind values through positional placeholders (see `placeholder`),
 * with the matching values supplied in `params`. The SQL stays dialect-naive
 * (ANSI joins + CTE, no Postgres-isms).
 */
interface HydratedDataRowsQuery {
  /** Omitted means the configured source locale, on the same localization path. */
  localeId?: string
  /**
   * Optional CTE body spliced as `with <cte> select …`. Provide the full
   * `name as ( … )` clause. Lets callers inline a filtered/paginated id set so
   * hydration happens in a single round-trip instead of one query per id.
   */
  cte?: string
  /**
   * Optional extra JOIN appended after the canonical user-ref joins — e.g.
   * `join filtered_ids on filtered_ids.id = data_rows.id` to restrict the
   * hydrated rows to a CTE's id set.
   */
  join?: string
  /** Optional WHERE fragment (omit when a `join` already restricts the rows). */
  where?: string
  /** Optional trailing `order by` / `limit` / `offset` clause. */
  tail?: string
  /** Positional values matching the placeholders across cte + where + tail. */
  params: unknown[]
}

/**
 * Run the canonical hydrated SELECT and map every row to a `DataRow`.
 */
export async function selectHydratedDataRows(
  db: DbClient,
  query: HydratedDataRowsQuery,
): Promise<DataRow[]> {
  const sourceLocale = await getDefaultLocale(db)
  const localeId = query.localeId === undefined ? sourceLocale.id : (await resolveContentLocale(db, query.localeId)).id
  const sql = `
    ${query.cte ? `with ${query.cte}` : ''}
    select ${DATA_ROW_COLUMNS}
    ${DATA_ROW_JOINS}
    ${query.join ?? ''}
    ${query.where ? `where ${query.where}` : ''}
    ${query.tail ?? ''}
  `
  const { rows } = await db.unsafe<DataRowRow>(sql, query.params)
  if (rows.length === 0) return []
  const localizations = await listContentLocalizations(db, { rowIds: rows.map((row) => row.id) })
  const byRow = new Map<string, Map<string, ContentLocalization>>()
  for (const localization of localizations) {
    let locales = byRow.get(localization.rowId)
    if (!locales) {
      locales = new Map()
      byRow.set(localization.rowId, locales)
    }
    locales.set(localization.localeId, localization)
  }
  const publisherIds = [...new Set(localizations.map((localization) => localization.publishedByUserId).filter((id): id is string => id !== null))]
  const publishers = new Map<string, NonNullable<DataRow['publishedBy']>>()
  const publicPaths = new Map<string, string | null>()
  const versionIds = [...new Set(localizations.map((localization) => localization.activeVersionId).filter((id): id is string => id !== null))]
  if (versionIds.length > 0) {
    const { rows: versions } = await db.unsafe<{ id: string; public_path: string | null }>(
      `select id, public_path from data_row_versions where id in (${versionIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')})`, versionIds,
    )
    for (const version of versions) publicPaths.set(version.id, version.public_path)
  }
  if (publisherIds.length > 0) {
    const { rows: users } = await db.unsafe<{
      id: string; email: string; display_name: string; role_slug: string | null; role_name: string | null
    }>(`select users.id, users.email, users.display_name, roles.slug as role_slug, roles.name as role_name
        from users left join roles on roles.id = users.role_id
        where users.id in (${publisherIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')})`, publisherIds)
    for (const user of users) {
      publishers.set(user.id, parseValue(DataUserReferenceSchema, {
        id: user.id, email: user.email, displayName: user.display_name || user.email,
        roleSlug: user.role_slug, roleName: user.role_name,
      }))
    }
  }
  return rows.map((row) => mapRow(
    row,
    localeId,
    byRow.get(row.id)?.get(localeId) ?? null,
    byRow.get(row.id)?.get(sourceLocale.id) ?? null,
    publishers.get(byRow.get(row.id)?.get(localeId)?.publishedByUserId ?? '') ?? null,
    publicPaths.get(byRow.get(row.id)?.get(localeId)?.activeVersionId ?? '') ?? null,
  ))
}
