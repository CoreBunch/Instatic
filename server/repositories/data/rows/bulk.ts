/**
 * Transactional batch operations for data rows. Each helper wraps the
 * matching single-row mutation in one transaction so a failure aborts the
 * whole batch.
 *
 *   createDataRowMany     — bulk-insert N draft rows
 *   saveDataRowDraftMany  — bulk-update N rows' draft cells + slug
 *   softDeleteDataRowMany — bulk-soft-delete N rows
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import type { InsertDataRowInput, UpdateDataRowDraftInput } from './mapper'
import { createDataRow, saveDataRowDraft, softDeleteDataRow } from './mutations'
import { notifyRowWrite, serializeCollabAwareWrite } from '../../rowWriteEvents'

/**
 * Bulk-insert N draft rows in a single transaction. Used by
 * `api.cms.content.table(slug).createMany(...)` — see plan §13 for the
 * "fail the batch" semantics (one slug conflict / DB error aborts the
 * entire batch).
 */
export async function createDataRowMany(
  db: DbClient,
  inputs: ReadonlyArray<InsertDataRowInput>,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow[]> {
  return serializeCollabAwareWrite(async () => {
    const created = await db.transaction(async (tx) => {
      const rows: DataRow[] = []
      for (const input of inputs) {
        rows.push(await createDataRow(
          tx,
          input,
          actorUserId,
          pluginActorId,
          { collabInternal: true },
        ))
      }
      return rows
    })
    for (const row of created) {
      notifyRowWrite({ tableId: row.tableId, rowIds: [row.id], kind: 'create' })
    }
    return created
  })
}

/**
 * Bulk-update N rows in a single transaction. Each update overrides the
 * row's draft cells AND slug — the caller pre-computes the denormalized
 * slug exactly as the per-row handler does.
 */
export async function saveDataRowDraftMany(
  db: DbClient,
  updates: ReadonlyArray<{ id: string; input: UpdateDataRowDraftInput }>,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow[]> {
  return serializeCollabAwareWrite(async () => {
    const updated = await db.transaction(async (tx) => {
      const rows: DataRow[] = []
      for (const { id, input } of updates) {
        const result = await saveDataRowDraft(
          tx,
          id,
          input,
          actorUserId,
          pluginActorId,
          { collabInternal: true },
        )
        if (result) rows.push(result)
      }
      return rows
    })
    for (const row of updated) {
      notifyRowWrite({ tableId: row.tableId, rowIds: [row.id], kind: 'update' })
    }
    return updated
  })
}

/**
 * Bulk-soft-delete N rows in a single transaction. Returns the number of
 * rows that were actually deleted (skips rows that were already missing
 * or soft-deleted), plus how many of those were `published` — callers use
 * that to invalidate the public render cache AFTER the transaction commits
 * (a published row's route is retracted by deletion; the bump must never
 * run inside the transaction because it serializes on the publish lock).
 */
export async function softDeleteDataRowMany(
  db: DbClient,
  rowIds: ReadonlyArray<string>,
  actorUserId: string | null = null,
): Promise<{ deleted: number; publishedDeleted: number }> {
  return serializeCollabAwareWrite(async () => {
    const deletedRows = await db.transaction(async (tx) => {
      const rows: NonNullable<Awaited<ReturnType<typeof softDeleteDataRow>>>[] = []
      for (const id of rowIds) {
        const result = await softDeleteDataRow(
          tx,
          id,
          actorUserId,
          { collabInternal: true },
        )
        if (result) rows.push(result)
      }
      return rows
    })
    for (const row of deletedRows) {
      notifyRowWrite({ tableId: row.tableId, rowIds: [row.id], kind: 'delete' })
    }
    return {
      deleted: deletedRows.length,
      publishedDeleted: deletedRows.filter((row) => row.status === 'published').length,
    }
  })
}
