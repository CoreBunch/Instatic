/**
 * Plugin page-tree handlers — implements the `cms.content.tree.*` api-calls
 * (read / mutate / replace the `pageTree` field of one entry).
 *
 * The `cms.content.*` permission is enforced centrally in apiDispatch.ts;
 * the per-table `contentAccess[]` check is `assertTreeReach` here, which
 * runs before anything about the entry or the field is said.
 */

import { parsePageNodeTree } from '@core/page-tree'
import type { DataRow, DataTable } from '@core/data/schemas'
import type { ContentAccessMode } from '@core/plugin-sdk/contentSchemas'
import type { DbClient } from '../../../db/client'
import { MAIN_SCOPE } from '../../../branches/scope'
import { mutatePageTree, readPageTree } from '../../../ai/content/treeService'
import { announceEntryUpdated, applyContentEntryCellsFilter } from '../../../publish/contentEvents'
import { getDataRow, getDataTable, saveDataRowDraft } from '../../../repositories/data'
import { keepPageStructuralCells } from '../../../writePolicy/pageStructuralCells'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import { pluginHasContentTableAccess } from '../registry'
import type { HostPluginRecord } from '../types'

// ---------------------------------------------------------------------------
// Tree — read / mutate / replace
// ---------------------------------------------------------------------------

/**
 * Resolve the table + row + field meta needed for any `tree.*` call.
 * Throws if the entry doesn't exist, the field doesn't exist, or the
 * field isn't a `pageTree`-typed cell.
 */
async function resolvePageTreeField(
  db: DbClient,
  entryId: string,
  fieldId: string,
): Promise<{ row: DataRow; table: DataTable }> {
  const row = await getDataRow(db, MAIN_SCOPE, entryId)
  if (!row) throw new Error(`Entry "${entryId}" not found`)
  const table = await getDataTable(db, MAIN_SCOPE, row.tableId)
  if (!table) throw new Error(`Table for entry "${entryId}" missing`)
  const field = table.fields.find((f) => f.id === fieldId)
  if (!field) throw new Error(`Field "${fieldId}" not found on table "${table.slug}"`)
  if (field.type !== 'pageTree') {
    throw new Error(`Field "${fieldId}" on table "${table.slug}" is not a pageTree field`)
  }
  return { row, table }
}

/**
 * The gate in front of every plugin page-tree call. Access is decided before
 * anything about the entry or the field is said: an entry that is missing, a
 * field that is missing or not a page tree, and a table the plugin lacks the
 * modes for all get the same refusal, so the call cannot be used to find out
 * what exists beyond the plugin's grant.
 */
async function assertTreeReach(
  entry: HostPluginRecord,
  db: DbClient,
  entryId: string,
  fieldId: string,
  modes: readonly ContentAccessMode[],
): Promise<void> {
  const row = await getDataRow(db, MAIN_SCOPE, entryId)
  const table = row ? await getDataTable(db, MAIN_SCOPE, row.tableId) : null
  const field = table?.fields.find((candidate) => candidate.id === fieldId)
  if (!table || field?.type !== 'pageTree' || !pluginHasContentTableAccess(entry, table, modes)) {
    throw new Error(`Page tree "${fieldId}" of entry "${entryId}" not found, or not within this plugin's content access.`)
  }
}

export async function handleContentTreeRead(
  msg: ApiCallFor<'cms.content.tree.read'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId] = msg.args
  await assertTreeReach(entry, db, entryId, fieldId, ['read'])
  const tree = await readPageTree(db, MAIN_SCOPE, entryId, fieldId)
  replyApiOk(msg.pluginId, msg.correlationId, tree)
}

export async function handleContentTreeMutate(
  msg: ApiCallFor<'cms.content.tree.mutate'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, operations] = msg.args
  // The call addresses existing nodes and is answered with the tree: it
  // needs the right to read the table as well as to write it.
  await assertTreeReach(entry, db, entryId, fieldId, ['read', 'write'])
  // Delegate to the shared, actor-agnostic page-tree service.
  const { tree, affectedNodeIds } = await mutatePageTree(
    db,
    MAIN_SCOPE,
    entryId,
    fieldId,
    operations,
    { kind: 'plugin', pluginId: msg.pluginId },
  )
  replyApiOk(msg.pluginId, msg.correlationId, { tree, affectedNodeIds })
}

export async function handleContentTreeReplace(
  msg: ApiCallFor<'cms.content.tree.replace'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, replacement] = msg.args
  await assertTreeReach(entry, db, entryId, fieldId, ['write'])
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)

  const replacementTree = parsePageNodeTree(
    replacement,
    `entry "${entryId}" field "${fieldId}" replacement`,
  )

  const actor = { kind: 'plugin', pluginId: msg.pluginId } as const
  const nextCells = await applyContentEntryCellsFilter(
    { ...row.cells, [fieldId]: replacementTree },
    { scope: MAIN_SCOPE, table, entryId, actor },
  )
  const updated = await saveDataRowDraft(
    db,
    MAIN_SCOPE,
    entryId,
    { cells: keepPageStructuralCells(row, nextCells), slug: row.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree replace`)
  await announceEntryUpdated(table, entryId, [fieldId], actor)
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}
