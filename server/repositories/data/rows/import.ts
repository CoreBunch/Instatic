/**
 * Bundle-import upserts for data rows. These bypass the normal CRUD path to
 * preserve the source instance's original id, status, and timestamps.
 *
 *   upsertDataRow         — id-preserving upsert (merge-overwrite / replace)
 *   insertDataRowIfAbsent — insert only if id absent (merge-add)
 *   replaceDataRow        — plain insert after wipe (replace strategy)
 *
 * User reference columns (author, createdBy, etc.) are intentionally dropped
 * on import: the user ids from the source instance will not exist in the target.
 *
 * Bundle ids are LOGICAL ids; the branch being imported into supplies the
 * physical key (see `@core/branches`).
 */
import { physicalId } from '@core/branches'
import type { DbClient } from '../../../db/client'
import type { BranchScope } from '../../../branches/scope'
import type { DataRowCells, DataRowStatus } from '@core/data/schemas'

export interface DataRowImportInput {
  id: string
  tableId: string
  cells: DataRowCells
  slug: string
  status: DataRowStatus
  publishedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Upsert a row preserving its original id, status, and timestamps. Used by
 * the `merge-overwrite` and `replace` import strategies.
 */
export async function upsertDataRow(
  db: DbClient,
  scope: BranchScope,
  input: DataRowImportInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  await db`
    insert into data_rows (
      id, branch_id, table_id, cells_json, slug, status,
      published_at, created_at, updated_at
    )
    values (
      ${physicalId(scope.branchId, input.id)}, ${scope.branchId},
      ${physicalId(scope.branchId, input.tableId)}, ${input.cells}, ${input.slug}, ${input.status},
      ${input.publishedAt}, ${createdAt}, ${updatedAt}
    )
    on conflict (id) do update
      set table_id    = excluded.table_id,
          cells_json  = excluded.cells_json,
          slug        = excluded.slug,
          status      = excluded.status,
          published_at = excluded.published_at,
          updated_at  = excluded.updated_at
  `
}

/**
 * Insert a row only when no uniqueness constraint is hit. Returns `true` when
 * the row was inserted, `false` when it was skipped (id conflict, or an active
 * row in the same table already owns the imported slug). Used by the
 * `merge-add` import strategy.
 *
 * RETURNING id is supported by both Postgres and SQLite, making this dialect-
 * neutral while still reporting whether an insert actually happened.
 */
export async function insertDataRowIfAbsent(
  db: DbClient,
  scope: BranchScope,
  input: DataRowImportInput,
): Promise<boolean> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  const { rows } = await db<{ id: string }>`
    insert into data_rows (
      id, branch_id, table_id, cells_json, slug, status,
      published_at, created_at, updated_at
    )
    values (
      ${physicalId(scope.branchId, input.id)}, ${scope.branchId},
      ${physicalId(scope.branchId, input.tableId)}, ${input.cells}, ${input.slug}, ${input.status},
      ${input.publishedAt}, ${createdAt}, ${updatedAt}
    )
    on conflict do nothing
    returning id
  `
  return rows.length > 0
}

/**
 * Plain INSERT with no conflict handling. Assumes the caller has already wiped
 * the branch's rows (as the `replace` strategy does). Returns void — the
 * caller does not need the inserted row shape.
 */
export async function replaceDataRow(
  db: DbClient,
  scope: BranchScope,
  input: DataRowImportInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  await db`
    insert into data_rows (
      id, branch_id, table_id, cells_json, slug, status,
      published_at, created_at, updated_at
    )
    values (
      ${physicalId(scope.branchId, input.id)}, ${scope.branchId},
      ${physicalId(scope.branchId, input.tableId)}, ${input.cells}, ${input.slug}, ${input.status},
      ${input.publishedAt}, ${createdAt}, ${updatedAt}
    )
  `
}
