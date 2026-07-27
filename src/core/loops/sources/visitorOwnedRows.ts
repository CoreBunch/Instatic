/**
 * Built-in `visitor.owned-rows` loop source — iterates the data rows owned by
 * the logged-in visitor (e.g. tenders they submitted via a form).
 *
 * Use-case B of the per-visitor-data framework: "Your tenders", "Your
 * applications". The source emits every non-deleted data row in a given
 * table whose `visitor_user_id` equals the resolved visitor's id. The row's
 * `cells_json` is spread into the item's `fields` (mirroring `data.rows`),
 * so any custom field the table defines resolves by its fieldId.
 *
 * `perVisitor: true` → the loop never bakes into static HTML, bypasses the
 * Layer B cache, and re-renders on every page load with
 * `Cache-Control: no-store`. Anonymous requests (no valid session) get an
 * empty item list, so the loop's children simply do not render — wrap the
 * loop in an auth-gated container to ensure it only shows behind a login.
 *
 * Identity is IDOR-safe: the resolved visitor arrives via `ctx.visitor`,
 * which the server prefetch layer derives SOLELY from the validated session
 * cookie. This source never reads a visitor id from filters/query/path — the
 * `visitor_user_id` filter is bound as a positional parameter from
 * `ctx.visitor.id` (cookie-derived), never from loop input.
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem, LoopSourceDb } from '@core/loops/types'
import { isoDate } from '../../utils/isoDate'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { publicDataUserFromParts } from '@core/data/publicDataUser'
import { readFeaturedMediaCell } from '@core/data/cells'
import type { DataRowCells } from '@core/data/schemas'
import { resolveMediaIdsToPaths } from './dataRows'

// ---------------------------------------------------------------------------
// Internal SQL row shape
// ---------------------------------------------------------------------------

/**
 * Mirrors `DataKindRowSqlRow` from `dataRows.ts` — owned-data rows live on the
 * same direct `data_rows` read path (forms submit into data-kind tables that
 * have no publish lifecycle), so the projection is identical save for the
 * extra `visitor_user_id` WHERE filter.
 */
interface OwnedDataRowSqlRow {
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

type OrderColumn = 'createdAt' | 'updatedAt' | 'slug'

const ALLOWED_ORDER_BY: ReadonlySet<OrderColumn> = new Set([
  'createdAt',
  'updatedAt',
  'slug',
])

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/**
 * Dialect-appropriate positional placeholder for `db.unsafe`:
 * `$<index>` on Postgres, `?` on SQLite. `index` is 1-based. Identical to the
 * helper in `dataRows.ts` — duplicated locally so this source stays
 * self-contained (the data-kind query needs explicit positional ordering).
 */
function positionalParam(db: LoopSourceDb, index: number): string {
  return db.dialect === 'postgres' ? `$${index}` : '?'
}

/**
 * Order column expressions. Owned-data rows have no `published_at` (they come
 * from the data-kind direct-read path, same as `fetchDataKindPage`), so a
 * `publishedAt` request is mapped to `createdAt` — mirroring the data-kind
 * ordering contract in `dataRows.ts`.
 */
const ORDER_COLUMN: Record<OrderColumn, string> = {
  createdAt: 'data_rows.created_at',
  updatedAt: 'data_rows.updated_at',
  slug: 'data_rows.slug',
}

// ---------------------------------------------------------------------------
// Row → LoopItem projection (mirrors `dataKindRowToLoopItem`)
// ---------------------------------------------------------------------------

function ownedRowToLoopItem(
  row: OwnedDataRowSqlRow,
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
      // Cells — all user-defined fields accessible by fieldId. Custom cell
      // fields resolve dynamically (the resolver is name-based), so the
      // declared `fields` list only covers the common bindings.
      ...cells,
      // System identity (overlay after cells so these are never shadowed)
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
      // Owned-data rows have no publishedAt — use createdAt as a proxy so
      // ordering / display stays consistent with the data-kind path.
      publishedAt: isoDate(row.created_at),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      permalink,
    },
  }
}

function extractFeaturedMediaIds(rows: OwnedDataRowSqlRow[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    const id = readFeaturedMediaCell(row.cells_json as DataRowCells)
    if (id) ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Page-slice query — owned-data rows for a single visitor
//
// Same shape as `fetchDataKindPage` in `dataRows.ts`, with an extra
// `and data_rows.visitor_user_id = <ctx.visitor.id>` predicate. The ORDER BY
// text comes only from the closed `ORDER_COLUMN` map; every runtime value
// rides as a positional parameter via `db.unsafe` — identical safety contract
// to `fetchDataKindPage`.
// ---------------------------------------------------------------------------

async function fetchOwnedRowsPage(
  db: LoopSourceDb,
  tableId: string,
  visitorId: string,
  orderBy: OrderColumn,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<OwnedDataRowSqlRow[]> {
  const orderColumn = ORDER_COLUMN[orderBy]
  const { rows } = await db.unsafe<OwnedDataRowSqlRow>(
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
       and data_rows.visitor_user_id = ${positionalParam(db, 2)}
       and data_rows.deleted_at is null
       and data_tables.deleted_at is null
     order by ${orderColumn} ${direction}, data_rows.id ${direction}
     limit ${positionalParam(db, 3)} offset ${positionalParam(db, 4)}`,
    [tableId, visitorId, limit, offset],
  )
  return rows
}

// ---------------------------------------------------------------------------
// Source export
// ---------------------------------------------------------------------------

export const VisitorOwnedRowsSource: LoopEntitySource = {
  id: 'visitor.owned-rows',
  label: 'My submitted rows',
  description:
    'Data rows owned by the logged-in visitor (e.g. tenders they submitted via a form). Per-visitor: anonymous requests render nothing.',

  // Per-visitor: cookie-derived, no-store, never baked into static HTML.
  perVisitor: true,

  filterSchema: {
    tableId: {
      type: 'select',
      label: 'Table',
      // Populated dynamically by the Properties Panel from the available data
      // tables — empty here keeps the schema valid before the list loads.
      options: [],
    },
  },

  orderByOptions: [
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Last updated' },
    { id: 'slug', label: 'Slug (A–Z)' },
  ],

  // Common bindings only — custom cell fields resolve dynamically (the
  // resolver is name-based and cells are spread into `fields` at fetch time).
  fields: [
    { id: 'slug', label: 'Slug' },
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Updated date' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    const visitor = ctx.visitor
    // No valid session → render nothing. The loop's children simply omit.
    if (!visitor) return { items: [], totalItems: 0 }

    const tableId = typeof ctx.filters.tableId === 'string' ? ctx.filters.tableId : ''
    if (!tableId) return { items: [], totalItems: 0 }

    const orderBy: OrderColumn = ALLOWED_ORDER_BY.has(ctx.orderBy as OrderColumn)
      ? (ctx.orderBy as OrderColumn)
      : 'createdAt'
    const direction: 'asc' | 'desc' = ctx.direction === 'asc' ? 'asc' : 'desc'

    // Total owned rows for this table — same visitor filter, no pagination.
    const { rows: countRows } = await ctx.db<{ total: number }>`
      select count(*) as total
      from data_rows
      where table_id = ${tableId}
        and visitor_user_id = ${visitor.id}
        and deleted_at is null
    `
    const totalItems = Number(countRows[0]?.total ?? 0)
    if (totalItems === 0) return { items: [], totalItems: 0 }

    const sqlRows = await fetchOwnedRowsPage(
      ctx.db, tableId, visitor.id, orderBy, direction, ctx.limit, ctx.offset,
    )
    // Same cheap batched featured-media resolution as `dataRows.ts` — one
    // round trip regardless of page size. Owned-data rows rarely carry
    // featured media, so the set is usually empty (a no-op query).
    const mediaPathMap = await resolveMediaIdsToPaths(ctx.db, extractFeaturedMediaIds(sqlRows))

    return {
      items: sqlRows.map((row) => ownedRowToLoopItem(row, mediaPathMap)),
      totalItems,
    }
  },

  preview() {
    // No DB is available to the synchronous preview path, and synthesising a
    // placeholder owned-row would leak a fake visitor identity into the
    // editor. The canvas loop-preview path renders real rows when needed;
    // this returns [] so no placeholder identity leaks.
    return []
  },
}
