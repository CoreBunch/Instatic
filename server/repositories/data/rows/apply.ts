/**
 * Explicit-delete row apply — the shared write path behind the transactional
 * site-document save (PUT /admin/api/cms/site-document).
 *
 * Unlike the retired roster reconcile (reap-by-omission: rows missing from a
 * shipped roster were soft-deleted, which required optimistic-concurrency
 * baselines to avoid eating sibling sessions' rows), deletion here is
 * EXPLICIT: the caller names the row ids to soft-delete. Rows the caller
 * doesn't mention are untouched — a stale client cannot delete anything by
 * omission.
 *
 * Ordering inside the transaction is load-bearing because of the partial
 * unique index `data_rows_table_slug_active_idx (table_id, slug) where
 * deleted_at is null and slug <> ''`, which is enforced per statement:
 *
 *   1. Delete FIRST. A written row may take the slug of a row this same
 *      request deletes (homepage swap + delete of the old homepage saved in
 *      one batch); the soft-delete frees the slug before any write needs it.
 *   2. Two-phase slug writes. Two written rows may SWAP slugs (A↔B) — no
 *      in-place update order can avoid a transient collision, so rows whose
 *      slug changes are parked on the placeholder slug '' (exempt from the
 *      unique index) together with their cells, then all final slugs land in
 *      a second pass once every old slug is free.
 *
 * Creates run after the deletes and placeholder parks, at which point no
 * active row holds any of the batch's final slugs (validation rejected
 * collisions with kept rows before the transaction started).
 *
 * A write whose id matches a SOFT-DELETED row revives that row instead of
 * inserting (the dead row still owns the primary key): undo of a delete
 * re-submits the row with its original id on the next save.
 *
 * Every written AND soft-deleted row is stamped with the save's site-global
 * `seq` (see repositories/syncSequence.ts) so delta queries surface both
 * kinds of change to reconnecting editors.
 *
 * `applyDataRowChangesInTx` assumes an OPEN transaction — the site-document
 * handler runs shell + components + layouts + pages through one transaction,
 * and nesting `db.transaction` wedges the SQLite adapter's serialized chain
 * (the 2026-06-12 audit's critical finding; do not reintroduce).
 * `applyDataRowChanges` is the standalone wrapper that opens one.
 */
import type { DbClient } from '../../../db/client'
import {
  createDataRow,
  updateDataRowDraftCells,
  updateDataRowSlug,
  resurrectDataRow,
  softDeleteDataRow,
} from './mutations'
import { listDataRowIdSlugs, listSoftDeletedDataRowIds } from './read'

export interface DataRowWrite {
  id: string
  cells: Record<string, unknown>
  slug: string
}

export interface ApplyDataRowChangesInput {
  tableId: string
  /** Rows to create/update, with their final slugs. */
  writes: DataRowWrite[]
  /** Row ids to soft-delete. Unknown / already-deleted ids are no-ops. */
  deleteIds: ReadonlySet<string>
  actorUserId: string
  /** The save's site-global sync seq, stamped on every written/deleted row. */
  seq: number
}

export interface ApplyDataRowChangesResult {
  /** True when any soft-deleted row was published (caller bumps the publish version AFTER commit). */
  deletedPublished: boolean
}

/** Stamp the sync seq on a row. Deliberately no `deleted_at` filter — soft-deleted rows are stamped too. */
async function stampDataRowSeq(db: DbClient, rowId: string, seq: number): Promise<void> {
  await db`
    update data_rows
    set seq = ${seq}
    where id = ${rowId}
  `
}

/**
 * Apply explicit row changes inside an ALREADY-OPEN transaction. See the
 * module doc for ordering. Callers must bump the publish version after the
 * surrounding transaction commits when `deletedPublished` is true.
 */
export async function applyDataRowChangesInTx(
  tx: DbClient,
  { tableId, writes, deleteIds, actorUserId, seq }: ApplyDataRowChangesInput,
): Promise<ApplyDataRowChangesResult> {
  let deletedPublished = false

  const existing = await listDataRowIdSlugs(tx, tableId)
  const existingSlugById = new Map(existing.map((r) => [r.id, r.slug]))
  const softDeletedIds = new Set(await listSoftDeletedDataRowIds(tx, tableId))

  // 1. Explicit deletes first — frees the slugs of deleted rows for the
  //    writes below. Deletes are SCOPED TO THIS TABLE: an id that doesn't
  //    belong to `tableId`'s live rows is skipped, so a crafted delete list
  //    can never soft-delete rows from another table (posts, components, …).
  //    Already-deleted / unknown ids no-op for the same reason (idempotent).
  for (const rowId of deleteIds) {
    if (!existingSlugById.has(rowId)) continue
    const deleted = await softDeleteDataRow(tx, rowId, actorUserId)
    if (!deleted) continue
    await stampDataRowSeq(tx, rowId, seq)
    if (deleted.status === 'published') deletedPublished = true
  }

  // 2. Write rows. Slug-changing updates park on '' (exempt from the unique
  //    index) so within-batch swaps can't transiently collide. A write whose
  //    id matches a SOFT-DELETED row is a revival (undo of a delete) — a
  //    plain insert would hit that row's primary key, so it is resurrected
  //    in place, parked, and re-slugged with the others.
  const parked: DataRowWrite[] = []
  for (const write of writes) {
    const storedSlug = existingSlugById.get(write.id)
    if (storedSlug === undefined) continue // created or revived below
    if (storedSlug === write.slug) {
      await updateDataRowDraftCells(tx, write.id, { cells: write.cells, slug: write.slug }, actorUserId)
    } else {
      await updateDataRowDraftCells(tx, write.id, { cells: write.cells, slug: '' }, actorUserId)
      parked.push(write)
    }
    await stampDataRowSeq(tx, write.id, seq)
  }
  for (const write of writes) {
    if (existingSlugById.has(write.id)) continue
    if (softDeletedIds.has(write.id)) {
      await resurrectDataRow(tx, write.id, { cells: write.cells, slug: '' }, actorUserId)
      parked.push(write)
    } else {
      await createDataRow(tx, { id: write.id, tableId, cells: write.cells, slug: write.slug }, actorUserId)
    }
    await stampDataRowSeq(tx, write.id, seq)
  }

  // 3. Final slugs for the parked rows — every old slug is free by now.
  for (const write of parked) {
    await updateDataRowSlug(tx, write.id, write.slug)
  }

  return { deletedPublished }
}

/**
 * Standalone wrapper: apply explicit row changes in their own short
 * transaction. For callers outside the site-document save (tests, future
 * single-table flows).
 */
export async function applyDataRowChanges(
  db: DbClient,
  input: ApplyDataRowChangesInput,
): Promise<ApplyDataRowChangesResult> {
  let result: ApplyDataRowChangesResult = { deletedPublished: false }
  await db.transaction(async (tx) => {
    result = await applyDataRowChangesInTx(tx, input)
  })
  return result
}
