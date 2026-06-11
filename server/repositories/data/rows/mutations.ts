/**
 * Single-row write mutations for data rows.
 *
 *   createDataRow        — insert a new draft
 *   saveDataRowDraft     — overwrite the draft cells and slug
 *   softDeleteDataRow    — set deleted_at
 *   updateDataRowTable   — move a row to another table (rejects on slug conflict)
 *   updateDataRowStatus  — flip between draft / unpublished
 *   updateDataRowAuthor  — reassign the author user id
 *
 * Mutations (other than soft-delete) always RETURN id only, then re-read the
 * hydrated row through `getDataRow` so callers receive consistently populated
 * user references. Soft-delete is the exception: a soft-deleted row is filtered
 * out by `getDataRow`'s `deleted_at is null` clause, so the row is mapped
 * directly from RETURNING. Because RETURNING carries no user-ref joins, the
 * result is a narrow `DeletedRowSummary` (not a `DataRow`) — the delete callers
 * only consume id / tableId / slug / status / deletedAt.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../../db/client'
import type { DataRow, DataRowStatus, DeletedRowSummary } from '@core/data/schemas'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import { type InsertDataRowInput, type UpdateDataRowDraftInput } from './mapper'
import { isoDateOrNull } from '@core/utils/isoDate'
import { getDataRow } from './read'

export type UpdateDataRowTableResult =
  | { ok: true; row: DataRow }
  | { ok: false; reason: 'row_not_found' | 'table_not_found' | 'slug_conflict' }

export async function createDataRow(
  db: DbClient,
  input: InsertDataRowInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow> {
  const { rows } = await db<{ id: string }>`
    insert into data_rows (
      id,
      table_id,
      cells_json,
      slug,
      status,
      author_user_id,
      created_by_user_id,
      updated_by_user_id,
      plugin_actor_id
    )
    values (
      ${input.id ?? nanoid()},
      ${input.tableId},
      ${input.cells},
      ${input.slug},
      ${'draft'},
      ${actorUserId},
      ${actorUserId},
      ${actorUserId},
      ${pluginActorId}
    )
    returning id
  `
  const created = await getDataRow(db, rows[0].id)
  if (!created) throw new Error('data row was created but could not be re-read')
  return created
}

export async function saveDataRowDraft(
  db: DbClient,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow | null> {
  const updated = await updateDataRowDraftCells(db, rowId, input, actorUserId, pluginActorId)
  return updated ? getDataRow(db, rowId) : null
}

/**
 * The write half of `saveDataRowDraft`, without the hydrated re-read. The
 * roster reconcilers (PUT /pages, PUT /components) discard the row anyway —
 * re-reading every saved row through the user-ref joins doubled their query
 * count per save. Returns whether a (non-deleted) row matched.
 */
export async function updateDataRowDraftCells(
  db: DbClient,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<boolean> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set cells_json = ${input.cells},
        slug = ${input.slug},
        updated_by_user_id = ${actorUserId},
        plugin_actor_id = ${pluginActorId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows.length > 0
}

/**
 * Revive a soft-deleted row with fresh draft cells — the roster reconcile's
 * answer to a client re-submitting an id it previously reaped (undo of a
 * delete). Clears `deleted_at` and overwrites cells/slug; the row keeps its
 * pre-delete status (publish state transitions stay with the publish flow).
 */
export async function resurrectDataRow(
  db: DbClient,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
): Promise<void> {
  await db`
    update data_rows
    set deleted_at = null,
        cells_json = ${input.cells},
        slug = ${input.slug},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is not null
  `
}

/**
 * Slug-only write — the second phase of the roster reconcile's two-phase
 * slug update (see rows/reconcile.ts). The row's cells and audit columns were
 * already written by `updateDataRowDraftCells` in the same transaction; this
 * just moves the row off the placeholder slug onto its final one.
 */
export async function updateDataRowSlug(
  db: DbClient,
  rowId: string,
  slug: string,
): Promise<void> {
  await db`
    update data_rows
    set slug = ${slug}
    where id = ${rowId}
      and deleted_at is null
  `
}

/**
 * Soft-delete is the one mutation that returns the row directly from
 * RETURNING rather than re-reading via `getDataRow`: the row now has
 * `deleted_at` set, so `getDataRow`'s `deleted_at is null` filter would mask
 * it. RETURNING carries no user-ref joins, so the result cannot be a hydrated
 * `DataRow` — it is a narrow `DeletedRowSummary` (id / tableId / slug / status /
 * deletedAt), which is all the soft-delete callers consume (audit logging +
 * artefact pruning).
 */
export async function softDeleteDataRow(
  db: DbClient,
  rowId: string,
  actorUserId: string | null = null,
): Promise<DeletedRowSummary | null> {
  const { rows } = await db<{
    id: string
    table_id: string
    slug: string
    status: DataRowStatus
    deleted_at: string | Date | null
  }>`
    update data_rows
    set deleted_at = current_timestamp,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id, table_id, slug, status, deleted_at
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    tableId: row.table_id,
    slug: row.slug,
    status: row.status,
    deletedAt: isoDateOrNull(row.deleted_at),
  }
}

/**
 * Move a row to another table. Refuses if the target table is missing or
 * already has a non-deleted row with the same (non-empty) slug. Returns a
 * discriminated union so handlers can map each failure mode to the right HTTP
 * status.
 */
export async function updateDataRowTable(
  db: DbClient,
  rowId: string,
  tableId: string,
  actorUserId: string | null = null,
): Promise<UpdateDataRowTableResult> {
  const row = await getDataRow(db, rowId)
  if (!row) return { ok: false, reason: 'row_not_found' }
  if (row.tableId === tableId) return { ok: true, row }

  const { rows: tableRows } = await db<{ id: string }>`
    select id from data_tables
    where id = ${tableId}
      and deleted_at is null
    limit 1
  `
  if (!tableRows[0]) return { ok: false, reason: 'table_not_found' }

  // Only check for slug conflicts when the row has a non-empty slug.
  if (row.slug) {
    const { rows: conflictRows } = await db<{ id: string }>`
      select id from data_rows
      where table_id = ${tableId}
        and slug = ${row.slug}
        and id <> ${rowId}
        and deleted_at is null
      limit 1
    `
    if (conflictRows[0]) return { ok: false, reason: 'slug_conflict' }
  }

  const { rows } = await db<{ id: string }>`
    update data_rows
    set table_id = ${tableId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return { ok: false, reason: 'row_not_found' }
  const updated = await getDataRow(db, rows[0].id)
  if (!updated) return { ok: false, reason: 'row_not_found' }
  // Moving a published row changes its public route (the route base comes
  // from the table) — invalidate the render cache so the old URL stops
  // being served.
  if (row.status === 'published') await bumpPublishVersionSerialized()
  return { ok: true, row: updated }
}

/**
 * Flip a row between `draft` and `unpublished` (the only states reachable
 * from this endpoint — `published` goes through the dedicated publish flow).
 * Always clears `published_at` / `published_by_user_id` since neither remains
 * meaningful in the new state.
 */
export async function updateDataRowStatus(
  db: DbClient,
  rowId: string,
  status: 'draft' | 'unpublished',
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = ${status},
        published_at = null,
        published_by_user_id = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return null
  // Invalidate the render cache — the route's published state changed.
  await bumpPublishVersionSerialized()
  return getDataRow(db, rows[0].id)
}

export async function updateDataRowAuthor(
  db: DbClient,
  rowId: string,
  authorUserId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set author_user_id = ${authorUserId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}
