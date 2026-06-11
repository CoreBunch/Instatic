/**
 * Hydrated read queries for data rows.
 *
 *   listDataRows          — non-deleted rows in a table, optionally restricted
 *                           to rows owned by the calling user
 *   getDataRow            — a single hydrated row (the canonical re-read every
 *                           mutation funnels through)
 *   getDataRowMany        — many hydrated rows by id, one IN-list query
 *   getDataRowBySlug      — a single row by its denormalized slug
 *   countDataRows         — non-deleted row count for a table
 *   listDataAuthorOptions — active users for the author picker
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import { selectHydratedDataRows, isOwnedByUser, placeholder } from './mapper'

interface ListDataRowsVisibility {
  /**
   * When set, only rows whose effective owner is this user id are returned.
   * Ownership: author overrides; when no author is assigned the creator is
   * the effective owner.
   */
  ownerUserId?: string | null
}

interface DataAuthorRow {
  id: string
  email: string
  display_name: string | null
  role_slug: string | null
  role_name: string | null
}

export async function listDataRows(
  db: DbClient,
  tableId: string,
  visibility: ListDataRowsVisibility = {},
): Promise<DataRow[]> {
  const dataRows = await selectHydratedDataRows(db, {
    where: `data_rows.table_id = ${placeholder(db.dialect, 1)} and data_rows.deleted_at is null`,
    params: [tableId],
    tail: 'order by data_rows.updated_at desc, data_rows.created_at desc',
  })
  if (visibility.ownerUserId) {
    const ownerUserId = visibility.ownerUserId
    return dataRows.filter((row) => isOwnedByUser(row, ownerUserId))
  }
  return dataRows
}

export interface DataRowIdSlug {
  id: string
  slug: string
}

/**
 * Lightweight (id, slug) projection of a table's non-deleted rows. The roster
 * reconcilers (PUT /pages, PUT /components) need exactly this — the reap diff
 * and the cross-row slug-uniqueness check — so they must not pay the hydrated
 * SELECT's full `cells_json` parse per row per save.
 */
export async function listDataRowIdSlugs(
  db: DbClient,
  tableId: string,
): Promise<DataRowIdSlug[]> {
  const { rows } = await db<DataRowIdSlug>`
    select id, slug from data_rows
    where table_id = ${tableId}
      and deleted_at is null
  `
  return rows
}

/**
 * Ids of a table's SOFT-DELETED rows. The roster reconcile needs them to tell
 * "create a new row" apart from "revive a reaped row whose id the client
 * re-submitted" (undo of a delete) — a plain insert on the latter would hit
 * the soft-deleted row's primary key.
 */
export async function listSoftDeletedDataRowIds(
  db: DbClient,
  tableId: string,
): Promise<string[]> {
  const { rows } = await db<{ id: string }>`
    select id from data_rows
    where table_id = ${tableId}
      and deleted_at is not null
  `
  return rows.map((r) => r.id)
}

export async function getDataRow(
  db: DbClient,
  rowId: string,
): Promise<DataRow | null> {
  const rows = await selectHydratedDataRows(db, {
    where: `data_rows.id = ${placeholder(db.dialect, 1)} and data_rows.deleted_at is null`,
    params: [rowId],
    tail: 'limit 1',
  })
  return rows[0] ?? null
}

/**
 * Read many non-deleted hydrated rows by id in ONE IN-list query. Rows come
 * back in no particular order — callers index them by id; an id absent from
 * the result is missing or soft-deleted. Used by the bulk plugin-content
 * handlers to validate/diff a batch without one round-trip per row.
 */
export async function getDataRowMany(
  db: DbClient,
  rowIds: ReadonlyArray<string>,
): Promise<DataRow[]> {
  if (rowIds.length === 0) return []
  const placeholders = rowIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')
  return selectHydratedDataRows(db, {
    where: `data_rows.id in (${placeholders}) and data_rows.deleted_at is null`,
    params: [...rowIds],
  })
}

/**
 * Read a non-deleted row in a table by its denormalized slug. Plain ANSI
 * SQL — the `data_rows_table_slug_active_idx` index covers this query
 * (the `where slug <> ''` partial guard does not exclude the lookup here
 * because we pass an explicit slug).
 */
export async function getDataRowBySlug(
  db: DbClient,
  tableId: string,
  slug: string,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    select id from data_rows
    where table_id = ${tableId}
      and slug = ${slug}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

/** Count non-deleted rows in a table — one indexed COUNT. */
export async function countDataRows(db: DbClient, tableId: string): Promise<number> {
  const { rows } = await db<{ count: number | string }>`
    select count(*) as count
    from data_rows
    where table_id = ${tableId}
      and deleted_at is null
  `
  return Number(rows[0]?.count ?? 0)
}

export async function listDataAuthorOptions(
  db: DbClient,
): Promise<Array<{ id: string; email: string; displayName: string; roleSlug: string | null; roleName: string | null }>> {
  const { rows } = await db<DataAuthorRow>`
    select users.id,
           users.email,
           users.display_name,
           roles.slug as role_slug,
           roles.name as role_name
    from users
    join roles on roles.id = users.role_id
    where users.deleted_at is null
      and users.status = ${'active'}
    order by users.display_name asc, users.email asc
  `
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? row.email ?? row.id,
    roleSlug: row.role_slug,
    roleName: row.role_name,
  }))
}
