/**
 * Actor-agnostic page-tree service — the single headless path for reading and
 * mutating a page/post node tree directly in storage (no browser, no live
 * editor canvas).
 *
 * This is the engine the editor's plugin RPC (`cms.content.tree.*`) and the
 * MCP server both ride. It loads the `pageTree` field of a `data_row`, applies
 * the 11 named tree operations through `applyTreeOperation`, re-validates, runs
 * the `content.entry.cells` filter pipeline, persists a draft, and emits the
 * `content.entry.updated` hook.
 *
 * Access control is the CALLER's responsibility and happens BEFORE the call:
 * the plugin handler decides it against the plugin's content access before
 * anything about the entry is said (`assertTreeReach`).
 */
import { applyTreeOperation, parsePageNodeTree, type TreeOperation } from '@core/page-tree'
import type { ContentEntryActor } from '@core/plugin-sdk'
import type { DataRow, DataTable } from '@core/data/schemas'
import type { DbClient } from '../../db/client'
import type { BranchScope } from '../../branches/scope'
import { getDataRow, getDataTable, saveDataRowDraft } from '../../repositories/data'
import { announceEntryUpdated, applyContentEntryCellsFilter } from '../../publish/contentEvents'
import { keepPageStructuralCells } from '../../writePolicy/pageStructuralCells'

async function resolvePageTreeField(
  db: DbClient,
  scope: BranchScope,
  entryId: string,
  fieldId: string,
): Promise<{ row: DataRow; table: DataTable }> {
  const row = await getDataRow(db, scope, entryId)
  if (!row) throw new Error(`Entry "${entryId}" not found`)
  const table = await getDataTable(db, scope, row.tableId)
  if (!table) throw new Error(`Table for entry "${entryId}" missing`)
  const field = table.fields.find((f) => f.id === fieldId)
  if (!field) throw new Error(`Field "${fieldId}" not found on table "${table.slug}"`)
  if (field.type !== 'pageTree') {
    throw new Error(`Field "${fieldId}" on table "${table.slug}" is not a pageTree field`)
  }
  return { row, table }
}

/** Map the canonical content actor onto saveDataRowDraft's (user, plugin) slots. */
function actorToSaveArgs(actor: ContentEntryActor): { actorUserId: string | null; pluginActorId: string | null } {
  if (actor.kind === 'user') return { actorUserId: actor.userId, pluginActorId: null }
  if (actor.kind === 'plugin') return { actorUserId: null, pluginActorId: actor.pluginId }
  return { actorUserId: null, pluginActorId: null } // system
}

export async function readPageTree(
  db: DbClient,
  scope: BranchScope,
  entryId: string,
  fieldId: string,
): Promise<unknown> {
  const { row } = await resolvePageTreeField(db, scope, entryId, fieldId)
  return row.cells[fieldId] ?? null
}

export async function mutatePageTree(
  db: DbClient,
  scope: BranchScope,
  entryId: string,
  fieldId: string,
  operations: readonly TreeOperation[],
  actor: ContentEntryActor,
): Promise<{ tree: unknown; affectedNodeIds: string[] }> {
  const { row, table } = await resolvePageTreeField(db, scope, entryId, fieldId)

  const initial = row.cells[fieldId]
  if (!initial || typeof initial !== 'object') {
    throw new Error(`Field "${fieldId}" on entry "${entryId}" is empty — cannot mutate a missing tree`)
  }
  // Deep-clone so in-place mutations never surface on the cached row reference.
  let tree = parsePageNodeTree(structuredClone(initial), `entry "${entryId}" field "${fieldId}"`)

  const affectedNodeIds: string[] = []
  for (const op of operations) {
    const result = applyTreeOperation(tree, op)
    tree = result.tree
    affectedNodeIds.push(...result.affectedNodeIds)
  }
  parsePageNodeTree(tree, `entry "${entryId}" field "${fieldId}" after mutation`)

  const nextCells = await applyContentEntryCellsFilter(
    { ...row.cells, [fieldId]: tree },
    { scope, table, entryId, actor },
  )
  const { actorUserId, pluginActorId } = actorToSaveArgs(actor)
  const updated = await saveDataRowDraft(
    db,
    scope,
    entryId,
    // The tree tools edit content; the page's access rule and head settings stay as stored.
    { cells: keepPageStructuralCells(row, nextCells), slug: row.slug },
    actorUserId,
    pluginActorId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree mutation`)

  await announceEntryUpdated(table, entryId, [fieldId], actor)

  return { tree, affectedNodeIds }
}
