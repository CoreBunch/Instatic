/**
 * Built-in `data.rows` loop source — iterates published data rows from a
 * data table (post-type or generic data-kind).
 *
 * Reads from `data_row_versions` joined to `data_rows`, `data_tables`, and
 * user/role tables, scoped to rows with `status = 'published'`. Featured
 * media resolution is handled in app code (not SQL) so the query stays
 * dialect-naive: after fetching the page of rows, a single batch query
 * resolves all unique media ids to their `public_path`.
 *
 * Order options:
 *   - publishedAt — most natural for post-type listings
 *   - createdAt   — first authored
 *   - updatedAt   — last modified
 *   - slug        — alphabetical by slug (closest dialect-neutral proxy for
 *                   title, which lives inside cells_json)
 *
 * Filters:
 *   - tableId (required) — the data table to iterate
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem, LoopSourceDb } from '@core/loops/types'
import { isoDate } from '../../utils/isoDate'
import { firstImagePathFromMarkdown } from '@core/markdown/renderMarkdown'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { publicDataUserFromParts } from '@core/data/publicDataUser'
import { readFeaturedMediaCell } from '@core/data/cells'
import type { DataRowCells } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Internal SQL row shape
// ---------------------------------------------------------------------------

interface PublishedDataRowSqlRow {
  version_id: string
  row_id: string
  table_id: string
  table_slug: string
  table_kind: string
  table_route_base: string
  version_number: number
  cells_json: Record<string, unknown>
  slug: string
  author_user_id: string | null
  author_display_name: string | null
  author_role_slug: string | null
  author_role_name: string | null
  published_by_user_id: string | null
  published_by_display_name: string | null
  published_by_role_slug: string | null
  published_by_role_name: string | null
  published_at: Date | string
  created_at: Date | string
  updated_at: Date | string
}

interface MediaAssetRow {
  id: string
  public_path: string
}

type OrderColumn = 'publishedAt' | 'createdAt' | 'updatedAt' | 'slug'

const ALLOWED_ORDER_BY: ReadonlySet<OrderColumn> = new Set([
  'publishedAt',
  'createdAt',
  'updatedAt',
  'slug',
])

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Dialect-appropriate positional placeholder for `db.unsafe`:
 * `$<index>` on Postgres, `?` on SQLite. `index` is 1-based.
 */
function positionalParam(db: LoopSourceDb, index: number): string {
  return db.dialect === 'postgres' ? `$${index}` : '?'
}

// ---------------------------------------------------------------------------
// Media path resolution
//
// Featured media lives inside cells_json, not as a SQL column. We extract
// the media id from each row's cells in TypeScript, deduplicate the set, and
// resolve all unique ids with a SINGLE batched IN-query. One round trip
// regardless of how many rows the page slice returned.
// ---------------------------------------------------------------------------

/**
 * Resolve a set of media asset ids to their public_path values in one query.
 * Uses db.unsafe with dialect-appropriate positional placeholders so the
 * same code works on both Postgres ($1, $2, …) and SQLite (?, ?, …).
 * Ids absent from the database are absent from the returned map.
 */
export async function resolveMediaIdsToPaths(
  db: LoopSourceDb,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const idList = [...new Set(ids)]
  const pathMap = new Map<string, string>()
  if (idList.length === 0) return pathMap
  const placeholders = idList.map((_, i) => positionalParam(db, i + 1)).join(', ')
  const { rows } = await db.unsafe<MediaAssetRow>(
    `select id, public_path from media_assets where id in (${placeholders})`,
    idList,
  )
  for (const row of rows) pathMap.set(row.id, row.public_path)
  return pathMap
}

function extractFeaturedMediaIds(rows: Array<{ cells_json: Record<string, unknown> }>): string[] {
  const ids: string[] = []
  for (const row of rows) {
    const id = readFeaturedMediaCell(row.cells_json as DataRowCells)
    if (id) ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Row → LoopItem projection
// ---------------------------------------------------------------------------

function rowToLoopItem(
  row: PublishedDataRowSqlRow,
  mediaPathMap: Map<string, string>,
): LoopItem {
  const cells = row.cells_json as DataRowCells
  const tableRouteBase = normalizeRouteBase(row.table_route_base || `/${row.table_slug}`)
  const permalink = `${tableRouteBase === '/' ? '' : tableRouteBase}/${row.slug}`

  // Extract first inline image from the `body` cell (post-type rows only).
  const bodyValue = cells['body']
  const firstImagePath = typeof bodyValue === 'string'
    ? firstImagePathFromMarkdown(bodyValue)
    : null

  const featuredMediaId = readFeaturedMediaCell(cells)
  const featuredMediaPath = featuredMediaId ? (mediaPathMap.get(featuredMediaId) ?? null) : null

  const author = publicDataUserFromParts(
    row.author_display_name,
    row.author_role_slug,
    row.author_role_name,
  )
  const publishedBy = publicDataUserFromParts(
    row.published_by_display_name,
    row.published_by_role_slug,
    row.published_by_role_name,
  )

  return {
    id: row.row_id,
    fields: {
      // Cells — all user-defined fields accessible by fieldId
      ...cells,
      // System identity (overlay after cells so these are never shadowed)
      id: row.row_id,
      rowId: row.row_id,
      versionId: row.version_id,
      versionNumber: Number(row.version_number),
      tableId: row.table_id,
      tableSlug: row.table_slug,
      // People
      author,
      authorName: author?.displayName ?? null,
      authorRoleSlug: author?.roleSlug ?? null,
      authorRoleName: author?.roleName ?? null,
      publishedBy,
      publishedByName: publishedBy?.displayName ?? null,
      publishedByRoleSlug: publishedBy?.roleSlug ?? null,
      publishedByRoleName: publishedBy?.roleName ?? null,
      // Media aliases
      featuredMediaId,
      featuredMedia: featuredMediaPath,
      featuredMediaPath,
      featuredMediaUrl: featuredMediaPath,
      firstImage: firstImagePath,
      firstImagePath,
      firstImageUrl: firstImagePath,
      // Dates / routing
      slug: row.slug,
      publishedAt: isoDate(row.published_at),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      permalink,
    },
  }
}

// ---------------------------------------------------------------------------
// Page-slice query — post-type tables (published-version join)
//
// One SELECT; the ORDER BY clause is composed from the closed, compile-time
// column map below, so no runtime input ever reaches the SQL text:
// `orderBy` is whitelisted against ALLOWED_ORDER_BY and `direction` is
// narrowed to 'asc' | 'desc' in `fetchPublishedDataRowItems` before either
// value gets here. All runtime VALUES (tableId, limit, offset) ride as
// positional parameters via `db.unsafe` — the same dialect-aware pattern as
// `resolveMediaIdsToPaths`.
// ---------------------------------------------------------------------------

/** Order column expressions for the post-type published-version query. */
const POST_TYPE_ORDER_COLUMN: Record<OrderColumn, string> = {
  publishedAt: 'data_row_versions.published_at',
  createdAt: 'data_row_versions.created_at',
  updatedAt: 'data_rows.updated_at',
  slug: 'data_row_versions.slug',
}

async function fetchPage(
  db: LoopSourceDb,
  tableId: string,
  orderBy: OrderColumn,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<PublishedDataRowSqlRow[]> {
  const orderColumn = POST_TYPE_ORDER_COLUMN[orderBy]
  const { rows } = await db.unsafe<PublishedDataRowSqlRow>(
    `select data_row_versions.id as version_id,
            data_rows.id as row_id,
            data_rows.table_id,
            data_tables.slug as table_slug,
            data_tables.kind as table_kind,
            data_tables.route_base as table_route_base,
            data_row_versions.version_number,
            data_row_versions.cells_json,
            data_row_versions.slug,
            data_rows.author_user_id,
            author_users.display_name as author_display_name,
            author_roles.slug as author_role_slug,
            author_roles.name as author_role_name,
            data_row_versions.published_by_user_id,
            publisher_users.display_name as published_by_display_name,
            publisher_roles.slug as published_by_role_slug,
            publisher_roles.name as published_by_role_name,
            data_row_versions.published_at,
            data_row_versions.created_at,
            data_rows.updated_at
     from data_rows
     join data_tables on data_tables.id = data_rows.table_id
     join data_row_versions on data_row_versions.id = data_rows.active_version_id
     left join users author_users on author_users.id = data_rows.author_user_id
     left join roles author_roles on author_roles.id = author_users.role_id
     left join users publisher_users on publisher_users.id = data_row_versions.published_by_user_id
     left join roles publisher_roles on publisher_roles.id = publisher_users.role_id
     where data_rows.table_id = ${positionalParam(db, 1)}
       and data_rows.status = 'published'
       and data_rows.deleted_at is null
       and data_tables.deleted_at is null
     order by ${orderColumn} ${direction}, data_row_versions.id ${direction}
     limit ${positionalParam(db, 2)} offset ${positionalParam(db, 3)}`,
    [tableId, limit, offset],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Page-slice query — data-kind tables (direct data_rows read)
//
// Data-kind tables (`kind: 'data'`) have no publish lifecycle and no
// `data_row_versions` rows. They are authored directly via the Data
// admin grid: cells live on `data_rows.cells_json`, and the row is
// "live" the moment it's created. Iterating them through the same
// published-version join the post-type path uses would silently return
// zero rows — which is exactly the "Lorem ipsum forever" bug authors
// were hitting in the canvas. So we query `data_rows` directly here.
// ---------------------------------------------------------------------------

interface DataKindRowSqlRow {
  row_id: string
  table_id: string
  table_slug: string
  table_route_base: string
  cells_json: Record<string, unknown>
  slug: string
  author_user_id: string | null
  author_display_name: string | null
  author_role_slug: string | null
  author_role_name: string | null
  created_at: Date | string
  updated_at: Date | string
}


function dataKindRowToLoopItem(
  row: DataKindRowSqlRow,
  mediaPathMap: Map<string, string>,
): LoopItem {
  const cells = row.cells_json as DataRowCells
  const tableRouteBase = normalizeRouteBase(row.table_route_base || `/${row.table_slug}`)
  const permalink = `${tableRouteBase === '/' ? '' : tableRouteBase}/${row.slug}`

  const featuredMediaId = readFeaturedMediaCell(cells)
  const featuredMediaPath = featuredMediaId ? (mediaPathMap.get(featuredMediaId) ?? null) : null

  const author = publicDataUserFromParts(
    row.author_display_name,
    row.author_role_slug,
    row.author_role_name,
  )

  return {
    id: row.row_id,
    fields: {
      ...cells,
      id: row.row_id,
      rowId: row.row_id,
      tableId: row.table_id,
      tableSlug: row.table_slug,
      author,
      authorName: author?.displayName ?? null,
      authorRoleSlug: author?.roleSlug ?? null,
      authorRoleName: author?.roleName ?? null,
      publishedBy: null,
      publishedByName: null,
      publishedByRoleSlug: null,
      publishedByRoleName: null,
      featuredMediaId,
      featuredMedia: featuredMediaPath,
      featuredMediaPath,
      featuredMediaUrl: featuredMediaPath,
      firstImage: null,
      firstImagePath: null,
      firstImageUrl: null,
      slug: row.slug,
      // Data-kind rows have no publishedAt — use createdAt as a proxy so
      // ordering / display stays consistent across both kinds.
      publishedAt: isoDate(row.created_at),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      permalink,
    },
  }
}

/**
 * Order column expressions for the data-kind query. There is no
 * `published_at` on this path — `fetchDataKindPage` maps a `publishedAt`
 * request to `createdAt` so "order by published date" still produces a
 * sensible newest-first ordering.
 */
const DATA_KIND_ORDER_COLUMN: Record<'createdAt' | 'updatedAt' | 'slug', string> = {
  createdAt: 'data_rows.created_at',
  updatedAt: 'data_rows.updated_at',
  slug: 'data_rows.slug',
}

async function fetchDataKindPage(
  db: LoopSourceDb,
  tableId: string,
  orderBy: OrderColumn,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<DataKindRowSqlRow[]> {
  const sortKey: 'createdAt' | 'updatedAt' | 'slug' =
    orderBy === 'updatedAt' ? 'updatedAt' : orderBy === 'slug' ? 'slug' : 'createdAt'
  const orderColumn = DATA_KIND_ORDER_COLUMN[sortKey]

  // Same safety contract as `fetchPage`: the ORDER BY text comes only from
  // the closed map above; every runtime value is a positional parameter.
  const { rows } = await db.unsafe<DataKindRowSqlRow>(
    `select data_rows.id as row_id,
            data_rows.table_id,
            data_tables.slug as table_slug,
            data_tables.route_base as table_route_base,
            data_rows.cells_json,
            data_rows.slug,
            data_rows.author_user_id,
            author_users.display_name as author_display_name,
            author_roles.slug as author_role_slug,
            author_roles.name as author_role_name,
            data_rows.created_at,
            data_rows.updated_at
     from data_rows
     join data_tables on data_tables.id = data_rows.table_id
     left join users author_users on author_users.id = data_rows.author_user_id
     left join roles author_roles on author_roles.id = author_users.role_id
     where data_rows.table_id = ${positionalParam(db, 1)}
       and data_rows.deleted_at is null
       and data_tables.deleted_at is null
     order by ${orderColumn} ${direction}, data_rows.id ${direction}
     limit ${positionalParam(db, 2)} offset ${positionalParam(db, 3)}`,
    [tableId, limit, offset],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Reusable fetch helper
//
// Extracted so both the publisher (`DataRowsSource.fetch`) and the admin
// loop-preview endpoint can return the same LoopItem projection without
// duplicating SQL or media-path logic. The admin endpoint doesn't have a
// `SourceFetchContext` to hand in — it only knows `(db, tableId, orderBy,
// direction, limit, offset)` — so this helper accepts those directly.
//
// Dispatch by table kind: post-type tables use the published-version join
// (active_version_id), data-kind tables read `data_rows` directly because
// they have no version workflow.
// ---------------------------------------------------------------------------

export async function fetchPublishedDataRowItems(
  db: LoopSourceDb,
  opts: {
    tableId: string
    orderBy: string
    direction: 'asc' | 'desc'
    limit: number
    offset: number
  },
): Promise<LoopFetchResult> {
  if (!opts.tableId) return { items: [], totalItems: 0 }

  const { rows: kindRows } = await db<{ kind: string }>`
    select kind
    from data_tables
    where id = ${opts.tableId}
      and deleted_at is null
    limit 1
  `
  const tableKind = kindRows[0]?.kind
  if (!tableKind) return { items: [], totalItems: 0 }

  const orderBy: OrderColumn = ALLOWED_ORDER_BY.has(opts.orderBy as OrderColumn)
    ? (opts.orderBy as OrderColumn)
    : 'publishedAt'
  const direction: 'asc' | 'desc' = opts.direction === 'asc' ? 'asc' : 'desc'

  if (tableKind === 'data') {
    const { rows: countRows } = await db<{ total: number }>`
      select count(*) as total
      from data_rows
      where table_id = ${opts.tableId}
        and deleted_at is null
    `
    const totalItems = Number(countRows[0]?.total ?? 0)
    if (totalItems === 0) return { items: [], totalItems: 0 }

    const sqlRows = await fetchDataKindPage(
      db, opts.tableId, orderBy, direction, opts.limit, opts.offset,
    )
    const mediaPathMap = await resolveMediaIdsToPaths(db, extractFeaturedMediaIds(sqlRows))
    return {
      items: sqlRows.map((row) => dataKindRowToLoopItem(row, mediaPathMap)),
      totalItems,
    }
  }

  // Post-type path (default): only published rows, joined to active version.
  const { rows: countRows } = await db<{ total: number }>`
    select count(*) as total
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    where data_rows.table_id = ${opts.tableId}
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
  `
  const totalItems = Number(countRows[0]?.total ?? 0)
  if (totalItems === 0) return { items: [], totalItems: 0 }

  const sqlRows = await fetchPage(db, opts.tableId, orderBy, direction, opts.limit, opts.offset)
  const mediaPathMap = await resolveMediaIdsToPaths(db, extractFeaturedMediaIds(sqlRows))

  return {
    items: sqlRows.map((row) => rowToLoopItem(row, mediaPathMap)),
    totalItems,
  }
}

// ---------------------------------------------------------------------------
// Source export
// ---------------------------------------------------------------------------

export const DataRowsSource: LoopEntitySource = {
  id: 'data.rows',
  label: 'Data rows',
  description: 'Loop published rows in a data table (posts, products, etc.).',

  filterSchema: {
    tableId: {
      type: 'select',
      label: 'Table',
      // Options are populated dynamically by the Properties Panel from the
      // available data tables — passing an empty list here keeps the schema
      // valid when the source is registered before the table list is loaded.
      options: [],
    },
  },

  orderByOptions: [
    { id: 'publishedAt', label: 'Published date' },
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Last updated' },
    { id: 'slug', label: 'Slug (A–Z)' },
  ],

  fields: [
    { id: 'slug', label: 'Slug' },
    { id: 'title', label: 'Title (post-type)' },
    { id: 'authorName', label: 'Author name' },
    { id: 'authorRoleName', label: 'Author role' },
    { id: 'body', label: 'Body (post-type, markdown)', format: 'html' },
    { id: 'featuredMedia', label: 'Featured media (post-type)', format: 'media' },
    { id: 'firstImage', label: 'First inline image', format: 'media' },
    { id: 'seoTitle', label: 'SEO title (post-type)' },
    { id: 'seoDescription', label: 'SEO description (post-type)' },
    { id: 'permalink', label: 'Permalink', format: 'url' },
    { id: 'publishedAt', label: 'Published date' },
    { id: 'publishedByName', label: 'Published by' },
    { id: 'publishedByRoleName', label: 'Publisher role' },
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Updated date' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    return fetchPublishedDataRowItems(ctx.db, {
      tableId: typeof ctx.filters.tableId === 'string' ? ctx.filters.tableId : '',
      orderBy: ctx.orderBy,
      direction: ctx.direction,
      limit: ctx.limit,
      offset: ctx.offset,
    })
  },

  preview() {
    // Editor-side preview is handled by the canvas via `useLoopPreviewItems`:
    // it first calls the admin endpoint `/data/tables/:id/loop-preview` to
    // fetch real published rows via `fetchPublishedDataRowItems` (this file),
    // and falls back to synthetic preview items from `dataTablePreviewToLoopItem`
    // when there are no published rows. This source's synchronous `preview()`
    // returns [] so no synthetic placeholder data leaks from the server source.
    return []
  },
}
