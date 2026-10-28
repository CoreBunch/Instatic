/**
 * A data row as a branch entity: its table, cells, and slug. Publish status
 * is never part of the content: a merge changes drafts, never what is live.
 */
import { physicalId } from '@core/branches'
import { encodeCollabDocId } from '@core/collab'
import { readDisplayTitle } from '@core/data/cells'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import type { DataRow, DataRowStatus } from '@core/data/schemas'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  getDataRow,
  listDataRows,
  saveDataRowDraft,
  softDeleteDataRow,
  updateDataRowTable,
  upsertDataRowDraft,
} from '../../repositories/data'
import { parseContent } from '../contentHash'
import { fieldChanges, treeDiff } from '../changeDetail'
import type { BranchEntityAdapter, BranchEntityOf } from './adapter'

const RowContentSchema = Type.Object({
  tableId: Type.String(),
  cells: Type.Record(Type.String(), Type.Unknown()),
  slug: Type.String(),
})
export type RowContent = Static<typeof RowContentSchema>
export type RowEntity = BranchEntityOf<'row', RowContent>

/**
 * A cell that is absent, null, or the empty string is the same empty cell.
 * Rows written by different paths disagree on which of the three they store
 * (an import keeps `""`, the relay drops the key), and that must never read
 * as a change, a conflict, or a "cleared" field in the review.
 */
function compactCells(cells: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cells)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

function rowContent(row: Pick<DataRow, 'tableId' | 'cells' | 'slug'>): RowContent {
  return { tableId: row.tableId, cells: compactCells(row.cells), slug: row.slug }
}

/** Tables whose `body` cell is a node tree. */
const TREE_TABLES = new Set(['pages', 'components', 'layouts'])

/** Built-in row fields carry the editor's labels; a custom field is named by its id. */
const ROW_LABELS: Record<string, string> = Object.fromEntries(
  buildPostTypeDefaultFields().map((field) => [field.id, field.label]),
)

function changedCellIds(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}

interface RawRow {
  logical_id: string
  table_id: string
  cells_json: Record<string, unknown>
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  published_by_user_id: string | null
  plugin_actor_id: string | null
  created_at: string | Date
  updated_at: string | Date
  published_at: string | Date | null
}

/**
 * A scheduled row cannot stay scheduled on a branch (only main publishes),
 * so it lands as a draft; every other status is informational ("live on
 * main") and survives the copy.
 */
function branchStatus(status: DataRowStatus): DataRowStatus {
  return status === 'scheduled' ? 'draft' : status
}

export const rowAdapter: BranchEntityAdapter<'row', RowContent> = {
  kind: 'row',
  order: () => 3,

  async collect(source): Promise<RowEntity[]> {
    const entities: RowEntity[] = []
    for (const table of await source.tables()) {
      for (const row of await listDataRows(source.db, source.scope, table.id)) {
        entities.push({
          kind: 'row',
          logicalId: row.id,
          label: readDisplayTitle(row.cells, table),
          tableId: table.id,
          tableName: table.singularLabel,
          content: rowContent(row),
        })
      }
    }
    return entities
  },

  parse: (value) => parseContent(RowContentSchema, value, 'row'),

  describe(before, after, conflicts, tableId) {
    const hasTree = tableId !== null && TREE_TABLES.has(tableId)
    const conflictSet = new Set(conflicts)
    const fields = fieldChanges(
      { ...(before?.cells ?? {}), slug: before?.slug },
      { ...(after?.cells ?? {}), slug: after?.slug },
      {
        prefix: 'cells.',
        conflicts: new Set([...conflictSet, ...(conflictSet.has('slug') ? ['cells.slug'] : [])]),
        skip: hasTree ? new Set(['body']) : undefined,
        labels: ROW_LABELS,
      },
    )
    return {
      kind: 'row',
      fields,
      tree: hasTree ? treeDiff(before?.cells.body, after?.cells.body) : null,
    }
  },

  async write(tx, scope, target, content, ctx) {
    const rowId = target.logicalId
    if (content === null) {
      const deleted = await softDeleteDataRow(tx, scope, rowId, ctx.actorUserId, { collabInternal: true })
      if (deleted) ctx.notices.rows.push({ kind: 'delete', tableId: deleted.tableId, rowId, changedFieldIds: [] })
      return
    }
    const existing = await getDataRow(tx, scope, rowId)
    if (existing) {
      if (existing.tableId !== content.tableId) {
        await updateDataRowTable(tx, scope, rowId, content.tableId, ctx.actorUserId, { collabInternal: true })
        ctx.notices.rows.push({ kind: 'delete', tableId: existing.tableId, rowId, changedFieldIds: [] })
      }
      await saveDataRowDraft(tx, scope, rowId, { cells: content.cells, slug: content.slug }, ctx.actorUserId, null, { collabInternal: true })
      ctx.notices.rows.push({
        kind: 'update',
        tableId: content.tableId,
        rowId,
        changedFieldIds: changedCellIds(existing.cells, content.cells),
      })
      return
    }
    await upsertDataRowDraft(
      tx,
      scope,
      { id: rowId, tableId: content.tableId, cells: content.cells, slug: content.slug },
      ctx.actorUserId,
      { collabInternal: true },
    )
    ctx.notices.rows.push({ kind: 'create', tableId: content.tableId, rowId, changedFieldIds: [] })
  },

  async copy(source, to) {
    // Live rows only; versions, schedules, and seqs do not cross. A row of a
    // table the table adapter did not copy (soft-deleted) has nowhere to go.
    const { db: tx, scope: from } = source
    const tablePhysicalIds = new Map<string, string>()
    for (const table of await source.tables()) {
      tablePhysicalIds.set(physicalId(from.branchId, table.id), physicalId(to.branchId, table.id))
    }
    const { rows } = await tx<RawRow>`
      select logical_id, table_id, cells_json, slug, status,
             author_user_id, created_by_user_id, updated_by_user_id, published_by_user_id,
             plugin_actor_id, created_at, updated_at, published_at
      from data_rows
      where branch_id = ${from.branchId}
        and deleted_at is null
    `
    for (const row of rows) {
      const tableId = tablePhysicalIds.get(row.table_id)
      if (!tableId) continue
      await tx`
        insert into data_rows (
          id, branch_id, table_id, cells_json, slug, status,
          author_user_id, created_by_user_id, updated_by_user_id, published_by_user_id,
          plugin_actor_id, created_at, updated_at, published_at
        )
        values (
          ${physicalId(to.branchId, row.logical_id)}, ${to.branchId},
          ${tableId}, ${row.cells_json}, ${row.slug}, ${branchStatus(row.status)},
          ${row.author_user_id}, ${row.created_by_user_id}, ${row.updated_by_user_id},
          ${row.published_by_user_id}, ${row.plugin_actor_id},
          ${row.created_at}, ${row.updated_at}, ${row.published_at}
        )
      `
    }
  },

  async remove(tx, branchId) {
    await tx`delete from data_rows where branch_id = ${branchId}`
    for (const kind of ['page', 'component', 'layout'] as const) {
      const prefix = `${encodeCollabDocId({ kind, branchId, rowId: '' })}%`
      await tx`delete from collab_documents where doc_id like ${prefix}`
    }
  },
}
