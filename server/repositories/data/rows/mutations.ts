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
 *
 * Ids in and out are LOGICAL; every statement binds the physical id for the
 * given `scope` (see `@core/branches`).
 */
import { nanoid } from 'nanoid'
import { logicalIdOf, physicalId } from '@core/branches'
import type { DbClient } from '../../../db/client'
import type { BranchScope } from '../../../branches/scope'
import type { DataRow, DataRowStatus, DeletedRowSummary } from '@core/data/schemas'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import { type InsertDataRowInput, type UpdateDataRowDraftInput } from './mapper'
import { isoDateOrNull } from '@core/utils/isoDate'
import { getDataRow } from './read'
import { notifyRowWrite, serializeCollabAwareWrite } from '../../rowWriteEvents'

type UpdateDataRowTableResult =
  | { ok: true; row: DataRow }
  | { ok: false; reason: 'row_not_found' | 'table_not_found' | 'slug_conflict' }

export async function createDataRow(
  db: DbClient,
  scope: BranchScope,
  input: InsertDataRowInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<DataRow> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      const created = await createDataRow(
        db,
        scope,
        input,
        actorUserId,
        pluginActorId,
        { collabInternal: true },
      )
      notifyRowWrite({
        branchId: scope.branchId,
        tableId: created.tableId,
        rowIds: [created.id],
        kind: 'create',
      })
      return created
    })
  }
  const logicalId = input.id ?? nanoid()
  const { rows } = await db<{ logical_id: string }>`
    insert into data_rows (
      id,
      branch_id,
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
      ${physicalId(scope.branchId, logicalId)},
      ${scope.branchId},
      ${physicalId(scope.branchId, input.tableId)},
      ${input.cells},
      ${input.slug},
      ${'draft'},
      ${actorUserId},
      ${actorUserId},
      ${actorUserId},
      ${pluginActorId}
    )
    returning logical_id
  `
  const created = await getDataRow(db, scope, rows[0].logical_id)
  if (!created) throw new Error('data row was created but could not be re-read')
  return created
}

export async function saveDataRowDraft(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<DataRow | null> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      const row = await saveDataRowDraft(
        db,
        scope,
        rowId,
        input,
        actorUserId,
        pluginActorId,
        { collabInternal: true },
      )
      if (row) {
        notifyRowWrite({ branchId: scope.branchId, tableId: row.tableId, rowIds: [row.id], kind: 'update' })
      }
      return row
    })
  }
  const updated = await updateDataRowDraftCells(db, scope, rowId, input, actorUserId, pluginActorId)
  return updated ? getDataRow(db, scope, rowId) : null
}

/**
 * The write half of `saveDataRowDraft`, without the hydrated re-read. The
 * roster reconcilers (PUT /pages, PUT /components) discard the row anyway —
 * re-reading every saved row through the user-ref joins doubled their query
 * count per save. Returns whether a (non-deleted) row matched.
 */
export async function updateDataRowDraftCells(
  db: DbClient,
  scope: BranchScope,
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
    where id = ${physicalId(scope.branchId, rowId)}
      and branch_id = ${scope.branchId}
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
  scope: BranchScope,
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
    where id = ${physicalId(scope.branchId, rowId)}
      and branch_id = ${scope.branchId}
      and deleted_at is not null
  `
}

/**
 * Idempotent draft write by id — update a live row, RESURRECT a soft-deleted
 * one, or create it fresh. The three-way decision the collab relay needs: a
 * row the roster sweep soft-deleted and a peer then restored (undo of a page
 * delete) still occupies its primary key, so a plain insert would conflict —
 * exactly the flow `apply.ts` handles for HTTP batches, here for one row.
 */
export async function upsertDataRowDraft(
  db: DbClient,
  scope: BranchScope,
  input: InsertDataRowInput & { id: string },
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<void> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      await upsertDataRowDraft(db, scope, input, actorUserId, { collabInternal: true })
      notifyRowWrite({ branchId: scope.branchId, tableId: input.tableId, rowIds: [input.id], kind: 'update' })
    })
  }
  const draft = { cells: input.cells, slug: input.slug }
  const updated = await updateDataRowDraftCells(db, scope, input.id, draft, actorUserId)
  if (updated) return
  const { rows } = await db<{ id: string }>`
    select id from data_rows
    where id = ${physicalId(scope.branchId, input.id)}
      and branch_id = ${scope.branchId}
      and deleted_at is not null
  `
  if (rows.length > 0) {
    await resurrectDataRow(db, scope, input.id, draft, actorUserId)
  } else {
    await createDataRow(db, scope, input, actorUserId, null, { collabInternal: true })
  }
}

/**
 * Slug-only write — the second phase of the roster reconcile's two-phase
 * slug update (see rows/reconcile.ts). The row's cells and audit columns were
 * already written by `updateDataRowDraftCells` in the same transaction; this
 * just moves the row off the placeholder slug onto its final one.
 */
export async function updateDataRowSlug(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  slug: string,
): Promise<void> {
  await db`
    update data_rows
    set slug = ${slug}
    where id = ${physicalId(scope.branchId, rowId)}
      and branch_id = ${scope.branchId}
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
  scope: BranchScope,
  rowId: string,
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<DeletedRowSummary | null> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      const row = await softDeleteDataRow(db, scope, rowId, actorUserId, { collabInternal: true })
      if (row) {
        notifyRowWrite({ branchId: scope.branchId, tableId: row.tableId, rowIds: [row.id], kind: 'delete' })
      }
      return row
    })
  }
  const { rows } = await db<{
    logical_id: string
    table_id: string
    slug: string
    status: DataRowStatus
    deleted_at: string | Date | null
  }>`
    update data_rows
    set deleted_at = current_timestamp,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${physicalId(scope.branchId, rowId)}
      and branch_id = ${scope.branchId}
      and deleted_at is null
    returning logical_id, table_id, slug, status, deleted_at
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.logical_id,
    tableId: logicalIdOf(scope.branchId, row.table_id),
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
  scope: BranchScope,
  rowId: string,
  tableId: string,
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<UpdateDataRowTableResult> {
  if (!opts.collabInternal) {
    const moved = await serializeCollabAwareWrite(async () => {
      const before = await getDataRow(db, scope, rowId)
      const result = await updateDataRowTable(
        db,
        scope,
        rowId,
        tableId,
        actorUserId,
        { collabInternal: true },
      )
      let bumpPublishVersion = false
      if (before && result.ok && before.tableId !== result.row.tableId) {
        // A table move changes both collection rosters. Emit the pair while
        // still holding the collab-aware write lane so a dirty old row doc
        // cannot land between the move and its synchronous invalidation.
        notifyRowWrite({ branchId: scope.branchId, tableId: before.tableId, rowIds: [rowId], kind: 'delete' })
        notifyRowWrite({ branchId: scope.branchId, tableId: result.row.tableId, rowIds: [rowId], kind: 'create' })
        bumpPublishVersion = before.status === 'published'
      }
      return { result, bumpPublishVersion }
    })
    // The publish lock may itself wait on persistence work. Never hold the
    // non-reentrant collab-aware lane while awaiting that independent lock.
    if (moved.bumpPublishVersion) await bumpPublishVersionSerialized()
    return moved.result
  }

  const row = await getDataRow(db, scope, rowId)
  if (!row) return { ok: false, reason: 'row_not_found' }
  if (row.tableId === tableId) return { ok: true, row }

  const targetTableId = physicalId(scope.branchId, tableId)
  const { rows: tableRows } = await db<{ id: string }>`
    select id from data_tables
    where id = ${targetTableId}
      and branch_id = ${scope.branchId}
      and deleted_at is null
    limit 1
  `
  if (!tableRows[0]) return { ok: false, reason: 'table_not_found' }

  const physicalRowId = physicalId(scope.branchId, rowId)
  // Only check for slug conflicts when the row has a non-empty slug.
  if (row.slug) {
    const { rows: conflictRows } = await db<{ id: string }>`
      select id from data_rows
      where table_id = ${targetTableId}
        and branch_id = ${scope.branchId}
        and slug = ${row.slug}
        and id <> ${physicalRowId}
        and deleted_at is null
      limit 1
    `
    if (conflictRows[0]) return { ok: false, reason: 'slug_conflict' }
  }

  const { rows } = await db<{ id: string }>`
    update data_rows
    set table_id = ${targetTableId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${physicalRowId}
      and branch_id = ${scope.branchId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return { ok: false, reason: 'row_not_found' }
  const updated = await getDataRow(db, scope, rowId)
  if (!updated) return { ok: false, reason: 'row_not_found' }
  return { ok: true, row: updated }
}

/**
 * Flip a row between `draft` and `unpublished` (the only states reachable
 * from this endpoint — `published` goes through the dedicated publish flow).
 * Always clears publish and schedule metadata since neither remains meaningful
 * in the retracted state.
 */
export async function updateDataRowStatus(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  status: 'draft' | 'unpublished',
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = ${status},
        published_at = null,
        published_by_user_id = null,
        scheduled_publish_at = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${physicalId(scope.branchId, rowId)}
      and branch_id = ${scope.branchId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return null
  // Invalidate the render cache — the route's published state changed.
  await bumpPublishVersionSerialized()
  return getDataRow(db, scope, rowId)
}

export async function updateDataRowAuthor(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  authorUserId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set author_user_id = ${authorUserId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${physicalId(scope.branchId, rowId)}
      and branch_id = ${scope.branchId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, scope, rowId) : null
}
