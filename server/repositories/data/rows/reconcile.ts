/**
 * Roster reconcile — the shared write path behind the editor's incremental
 * saves (PUT /pages, /components, /layouts). One transaction that makes
 * storage match the client's roster: write the changed rows, soft-delete the
 * dropped ones.
 *
 * Ordering inside the transaction is load-bearing because of the partial
 * unique index `data_rows_table_slug_active_idx (table_id, slug) where
 * deleted_at is null and slug <> ''`, which is enforced per statement:
 *
 *   1. Reap FIRST. A changed row may take the slug of a row this same
 *      request deletes (homepage swap + delete of the old homepage saved in
 *      one batch); the soft-delete frees the slug before any write needs it.
 *   2. Two-phase slug writes. Two changed rows may SWAP slugs (A↔B) — no
 *      in-place update order can avoid a transient collision, so rows whose
 *      slug changes are parked on the placeholder slug '' (exempt from the
 *      unique index) together with their cells, then all final slugs land in
 *      a second pass once every old slug is free.
 *
 * Creates run after the reaps and placeholder parks, at which point no
 * active row holds any of the batch's final slugs (validation rejected
 * collisions with kept rows before the transaction started).
 *
 * A write whose id matches a SOFT-DELETED row revives that row instead of
 * inserting (the dead row still owns the primary key): undo of a delete
 * re-submits the page with its original id on the next save.
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

/**
 * Decide which existing rows to soft-delete during a roster reconcile.
 *
 * With `baselineIds` (the row ids the saving client loaded), only reap a row
 * the client knew about and dropped — never a row another session created
 * concurrently, which the saving client never saw (ISS-041). With no baseline,
 * reap every row missing from the incoming set (authoritative full replace,
 * e.g. an import).
 */
export function rowsToReap(
  existingIds: Iterable<string>,
  incomingIds: ReadonlySet<string>,
  baselineIds?: ReadonlySet<string>,
): string[] {
  return [...existingIds].filter(
    (id) => !incomingIds.has(id) && (baselineIds ? baselineIds.has(id) : true),
  )
}

export interface RowRosterWrite {
  id: string
  cells: Record<string, unknown>
  slug: string
}

export interface ReconcileRowRosterInput {
  tableId: string
  /** The changed rows to create/update, with their final slugs. */
  writes: RowRosterWrite[]
  /** The client's FULL row-id roster — rows missing from it are reaped. */
  keepIds: ReadonlySet<string>
  /** Optimistic-concurrency baseline (ISS-041); absent = full replace. */
  baselineIds?: ReadonlySet<string>
  actorUserId: string
}

/**
 * Reconcile a table's rows to the client's roster in one short transaction.
 * Returns whether any reaped row was published — callers that own public
 * routes (pages) bump the publish version AFTER the transaction commits.
 */
export async function reconcileDataRowRoster(
  db: DbClient,
  { tableId, writes, keepIds, baselineIds, actorUserId }: ReconcileRowRosterInput,
): Promise<{ reapedPublished: boolean }> {
  let reapedPublished = false

  await db.transaction(async (tx) => {
    const existing = await listDataRowIdSlugs(tx, tableId)
    const existingSlugById = new Map(existing.map((r) => [r.id, r.slug]))
    const softDeletedIds = new Set(await listSoftDeletedDataRowIds(tx, tableId))

    // 1. Reap first — frees the slugs of dropped rows for the writes below.
    for (const rowId of rowsToReap(existingSlugById.keys(), keepIds, baselineIds)) {
      const deleted = await softDeleteDataRow(tx, rowId, actorUserId)
      if (deleted?.status === 'published') reapedPublished = true
    }

    // 2. Write changed rows. Slug-changing updates park on '' (exempt from
    //    the unique index) so within-batch swaps can't transiently collide.
    //    A write whose id matches a SOFT-DELETED row is a revival (undo of a
    //    delete) — a plain insert would hit that row's primary key, so it is
    //    resurrected in place, parked, and re-slugged with the others.
    const parked: RowRosterWrite[] = []
    for (const write of writes) {
      const storedSlug = existingSlugById.get(write.id)
      if (storedSlug === undefined) continue // created or revived below
      if (storedSlug === write.slug) {
        await updateDataRowDraftCells(tx, write.id, { cells: write.cells, slug: write.slug }, actorUserId)
      } else {
        await updateDataRowDraftCells(tx, write.id, { cells: write.cells, slug: '' }, actorUserId)
        parked.push(write)
      }
    }
    for (const write of writes) {
      if (existingSlugById.has(write.id)) continue
      if (softDeletedIds.has(write.id)) {
        await resurrectDataRow(tx, write.id, { cells: write.cells, slug: '' }, actorUserId)
        parked.push(write)
      } else {
        await createDataRow(tx, { id: write.id, tableId, cells: write.cells, slug: write.slug }, actorUserId)
      }
    }

    // 3. Final slugs for the parked rows — every old slug is free by now.
    for (const write of parked) {
      await updateDataRowSlug(tx, write.id, write.slug)
    }
  })

  return { reapedPublished }
}
