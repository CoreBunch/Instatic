/**
 * CMS content handlers — implements every `cms.content.*` api-call.
 *
 * The handlers expose the host's content tables (`data_tables` + `data_rows`)
 * to plugins through a permissioned, per-table-allowlisted surface. The
 * `cms.content.*` permission family is enforced CENTRALLY in `apiDispatch.ts`
 * (driven by `TARGET_PERMISSIONS`) before any handler runs, so each handler:
 *
 *   1. Calls `assertContentTableAccess` — enforces the manifest's
 *      `contentAccess[]` allowlist for the targeted table + mode (this is the
 *      per-table check the central permission gate cannot express).
 *   2. Delegates to a repository function in `server/repositories/data/`.
 *   3. Emits the matching `content.entry.*` hook event so plugins can react.
 *   4. Replies via `replyApiOk` / lets the dispatcher's try/catch reply
 *      `replyApiError` on throw.
 *
 * Pre-release rule (CLAUDE.md): no backward compatibility. The legacy
 * `cms.pages.*` surface is deleted in this same change set.
 */

import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { ContentTableSummary, PublishedSnapshot } from '@core/plugin-sdk/contentSchemas'
import type { DataRow, DataTable } from '@core/data/schemas'
import { parsePageNodeTree } from '@core/page-tree'
import { readPageTree, mutatePageTree } from '../../../ai/content/treeService'
import {
  listDataTablesWithCounts,
  getDataTable,
  createDataTable,
  listDataRowsWithFilter,
  getDataRow,
  getDataRowMany,
  getDataRowBySlug,
  countDataRows,
  searchDataRows,
  createDataRow,
  createDataRowMany,
  saveDataRowDraft,
  saveDataRowDraftMany,
  softDeleteDataRow,
  softDeleteDataRowMany,
  updateDataRowTable,
  updateDataRowStatus,
  getPublishedDataRowById,
} from '../../../repositories/data'
import { publishDataRow } from '../../../publish/publishRow'
import { republishAllPages } from '../../../publish/republish'
import { refreshPublishedRoutes } from '../../../publish/rebakePublishedRoutes'
import { getPublishedPageSnapshotById } from '../../../repositories/publish'
import { pageToCells } from '@core/data/pageFromRow'
import { getDefaultLocale, getLocale, listLocales, LocalizationError } from '../../../repositories/localization'
import { scheduleLocalizedDataRowPublish } from '../../../publish/schedulePublication'
import { applyContentEntryCellsFilter, emitContentEntryCreated, emitContentEntryUpdated, emitContentEntryDeleted } from '../../../publish/contentEvents'
import type { DbClient } from '../../../db/client'
import { assertContentTableAccess, getPluginUploadsDir } from '../registry'
import { buildContentTableIdLookup, pluginContentFieldsToDataFields } from '../contentFieldMapping'
import {
  buildTableSlugLookup,
  denormalizeSlug,
  resolveTableBySlug,
  rowToEntry,
  tableSchema,
  tableSummary,
} from './contentProjection'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

// Projection helpers (DB → wire shapes) live in `contentProjection.ts`.

// ---------------------------------------------------------------------------
// Hook emission — actor-attributed `content.entry.*` events
// ---------------------------------------------------------------------------

interface PluginActor {
  kind: 'plugin'
  pluginId: string
}

async function requestedLocaleId(db: DbClient, localeId?: string): Promise<string> {
  const locale = localeId ? await getLocale(db, localeId) : await getDefaultLocale(db)
  if (!locale) throw new LocalizationError('Unknown content language', 'localeId')
  return locale.id
}

export async function handleContentLocalesList(msg: ApiCallFor<'cms.content.locales.list'>, _entry: HostPluginRecord, db: DbClient): Promise<void> {
  replyApiOk(msg.pluginId, msg.correlationId, await listLocales(db))
}

/** Diff two cell-bags by key. Falls back to whole-object compare per key. */
function diffCells(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const changed: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (before[key] !== after[key]) {
      // Reference equality skips deep compares for nested objects (page
      // trees, cell objects). Plugins watch this list; false positives are
      // fine, false negatives are not — fall through if the references
      // differ at all.
      changed.push(key)
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Tables — list / get / create
// ---------------------------------------------------------------------------

export async function handleContentTablesList(
  msg: ApiCallFor<'cms.content.tables.list'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const allowedSlugs = new Set((entry.manifest.contentAccess ?? []).map((e) => e.table))
  const tables = await listDataTablesWithCounts(db)
  const summaries: ContentTableSummary[] = tables
    .filter((t) => allowedSlugs.has(t.slug))
    .map((t) => tableSummary(t, t.rowCount))
  replyApiOk(msg.pluginId, msg.correlationId, summaries)
}

export async function handleContentTablesGet(
  msg: ApiCallFor<'cms.content.tables.get'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [slug] = msg.args
  assertContentTableAccess(entry, slug, 'read')
  const table = await resolveTableBySlug(db, slug).catch(() => null)
  if (!table) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  // One COUNT for this table + the id→slug lookup the relation-field
  // projection needs — no per-table COUNT subselects for tables we don't
  // return.
  const [rowCount, slugLookup] = await Promise.all([
    countDataRows(db, table.id),
    buildTableSlugLookup(db),
  ])
  replyApiOk(
    msg.pluginId,
    msg.correlationId,
    tableSchema(table, rowCount, slugLookup),
  )
}

export async function handleContentTablesCreate(
  msg: ApiCallFor<'cms.content.tables.create'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [input] = msg.args
  // System tables are seeded only; the underlying repository does not accept
  // a `system: true` flag from this entry point — defense-in-depth here too.
  if (input.slug === 'pages' || input.slug === 'posts' || input.slug === 'components' || input.slug === 'layouts') {
    throw new Error(`Cannot create a table with the reserved system slug "${input.slug}"`)
  }
  const tableIdBySlug = input.fields?.some((field) => field.type === 'relation')
    ? await buildContentTableIdLookup(db)
    : new Map<string, string>()
  const fields = pluginContentFieldsToDataFields(input.fields ?? [], tableIdBySlug)
  const created = await createDataTable(db, {
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? 'data',
    routeBase: input.routeBase,
    singularLabel: input.singularLabel,
    pluralLabel: input.pluralLabel,
    primaryFieldId: input.primaryFieldId ?? 'title',
    fields,
  })
  const slugLookup = await buildTableSlugLookup(db)
  replyApiOk(msg.pluginId, msg.correlationId, tableSchema(created, 0, slugLookup))
}

// ---------------------------------------------------------------------------
// Entries — CRUD + bulk
// ---------------------------------------------------------------------------

export async function handleContentEntriesList(
  msg: ApiCallFor<'cms.content.entries.list'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const result = await listDataRowsWithFilter(db, table.id, options)
  replyApiOk(msg.pluginId, msg.correlationId, {
    entries: result.rows.map((r) => rowToEntry(r, tableSlug)),
    totalCount: result.totalCount,
  })
}

export async function handleContentEntriesGet(
  msg: ApiCallFor<'cms.content.entries.get'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const row = await getDataRow(db, entryId, options.localeId)
  if (!row || row.tableId !== table.id) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(row, tableSlug))
}

export async function handleContentEntriesGetBySlug(
  msg: ApiCallFor<'cms.content.entries.getBySlug'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, slug, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const row = await getDataRowBySlug(db, table.id, slug, options.localeId)
  replyApiOk(msg.pluginId, msg.correlationId, row ? rowToEntry(row, tableSlug) : null)
}

export async function handleContentEntriesCreate(
  msg: ApiCallFor<'cms.content.entries.create'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, input] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const localeId = await requestedLocaleId(db, input.localeId)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const cells = await applyContentEntryCellsFilter(input.cells, {
    tableSlug,
    entryId: 'new',
    localeId,
    actor,
  })
  const slug = input.slug ?? denormalizeSlug(table, cells)
  const created = await createDataRow(
    db,
    { tableId: table.id, cells, slug, localeId },
    null,
    msg.pluginId,
  )
  await emitContentEntryCreated(db, created.id, actor, created.localeId)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(created, tableSlug))
}

export async function handleContentEntriesUpdate(
  msg: ApiCallFor<'cms.content.entries.update'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, patch] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId, patch.localeId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
  const filteredCells = await applyContentEntryCellsFilter(mergedCells, {
    tableSlug,
    entryId,
    localeId: existing.localeId,
    actor,
  })
  const changedIds = diffCells(existing.cells, filteredCells)
  // `denormalizeSlug` returns '' for tables without a slug field (or when the
  // slug cell is cleared); fall back to the existing slug so an update never
  // silently blanks the row's public path.
  const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: filteredCells, slug: nextSlug || existing.slug, localeId: existing.localeId },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated`)
  if (changedIds.length > 0) {
    await emitContentEntryUpdated(db, entryId, changedIds, actor, existing.localeId)
  }
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(updated, tableSlug))
}

export async function handleContentEntriesDelete(
  msg: ApiCallFor<'cms.content.entries.delete'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId] = msg.args
  assertContentTableAccess(entry, tableSlug, 'delete')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const deleted = await softDeleteDataRow(db, entryId)
  if (deleted) {
    const uploadsDir = getPluginUploadsDir(db)
    if (uploadsDir) await refreshPublishedRoutes(db, uploadsDir)
    await emitContentEntryDeleted(db, entryId, { kind: 'plugin', pluginId: msg.pluginId })
  }
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}

export async function handleContentEntriesPublish(
  msg: ApiCallFor<'cms.content.entries.publish'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'publish')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId, options.localeId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  if (options.scheduledFor) {
    const scheduled = await scheduleLocalizedDataRowPublish(db, entryId, options.scheduledFor, null, existing.localeId)
    if (!scheduled) throw new Error(`Entry "${entryId}" could not be scheduled`)
    await emitContentEntryUpdated(db, entryId, ['status'], actor, existing.localeId)
    replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(scheduled, tableSlug))
    return
  }

  const result = await publishDataRow(db, entryId, null, getPluginUploadsDir(db), { localeId: existing.localeId })
  await emitContentEntryUpdated(db, entryId, ['status'], actor, existing.localeId)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(result.row, tableSlug))
}

export async function handleContentEntriesUnpublish(
  msg: ApiCallFor<'cms.content.entries.unpublish'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'publish')
  const table = await resolveTableBySlug(db, tableSlug)
  const existing = await getDataRow(db, entryId, options.localeId)
  if (!existing || existing.tableId !== table.id) throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  const row = await updateDataRowStatus(db, entryId, 'unpublished', null, existing.localeId)
  if (!row) throw new Error('Content could not be taken offline')
  const uploadsDir = getPluginUploadsDir(db)
  if (uploadsDir) await refreshPublishedRoutes(db, uploadsDir)
  await emitContentEntryUpdated(db, entryId, ['status'], { kind: 'plugin', pluginId: msg.pluginId }, row.localeId)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(row, tableSlug))
}

export async function handleContentEntriesMoveTable(
  msg: ApiCallFor<'cms.content.entries.moveTable'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, targetSlug, options] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  assertContentTableAccess(entry, targetSlug, 'write')
  const source = await resolveTableBySlug(db, tableSlug)
  const target = await resolveTableBySlug(db, targetSlug)
  const existing = await getDataRow(db, entryId, options.localeId)
  if (!existing || existing.tableId !== source.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const result = await updateDataRowTable(db, entryId, target.id, null, { localeId: existing.localeId })
  if (!result.ok) throw new Error(`moveToTable failed: ${result.reason}`)
  const uploadsDir = getPluginUploadsDir(db)
  if (uploadsDir) await refreshPublishedRoutes(db, uploadsDir)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  await emitContentEntryUpdated(db, entryId, ['tableId'], actor, null)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(result.row, targetSlug))
}

// ── Bulk ─────────────────────────────────────────────────────────────────

export async function handleContentEntriesCreateMany(
  msg: ApiCallFor<'cms.content.entries.createMany'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, inputs] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  // Apply the cells filter per-input before the transaction. The filter
  // runs INSIDE the same plugin's worker; running it inside the per-row
  // transaction would tie up the DB connection.
  const prepared = await Promise.all(inputs.map(async (input) => {
    const localeId = await requestedLocaleId(db, input.localeId)
    const cells = await applyContentEntryCellsFilter(input.cells, { tableSlug, entryId: 'new', localeId, actor })
    const slug = input.slug ?? denormalizeSlug(table, cells)
    return { tableId: table.id, cells, slug, localeId }
  }))
  const created = await createDataRowMany(db, prepared, null, msg.pluginId)
  for (const row of created) {
    await emitContentEntryCreated(db, row.id, actor, row.localeId)
  }
  replyApiOk(msg.pluginId, msg.correlationId, created.map((r) => rowToEntry(r, tableSlug)))
}

export async function handleContentEntriesUpdateMany(
  msg: ApiCallFor<'cms.content.entries.updateMany'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, updates] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  const table = await resolveTableBySlug(db, tableSlug)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  // Read every targeted row in ONE IN-list query, then apply filter + diff
  // per-row before the transaction. Iterating `updates` in input order
  // preserves the first-bad-id error semantics of the old per-row reads.
  const localeIds = await Promise.all(updates.map((update) => requestedLocaleId(db, update.patch.localeId)))
  const localeGroups = new Map<string, string[]>()
  updates.forEach((update, index) => localeGroups.set(localeIds[index], [...(localeGroups.get(localeIds[index]) ?? []), update.id]))
  const existingByLocale = new Map<string, Map<string, DataRow>>()
  await Promise.all([...localeGroups].map(async ([localeId, ids]) => {
    existingByLocale.set(localeId, new Map((await getDataRowMany(db, ids, localeId)).map((row) => [row.id, row])))
  }))
  const prepared: Array<{ id: string; input: { cells: Record<string, unknown>; slug: string; localeId: string }; changedIds: string[] }> = []
  for (const [index, { id, patch }] of updates.entries()) {
    const existing = existingByLocale.get(localeIds[index])?.get(id)
    if (!existing || existing.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
    const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
    const filteredCells = await applyContentEntryCellsFilter(mergedCells, {
      tableSlug,
      entryId: id,
      localeId: existing.localeId,
      actor,
    })
    const changedIds = diffCells(existing.cells, filteredCells)
    const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
    prepared.push({
      id,
      input: { cells: filteredCells, slug: nextSlug || existing.slug, localeId: existing.localeId },
      changedIds,
    })
  }
  const updated = await saveDataRowDraftMany(
    db,
    prepared.map((p) => ({ id: p.id, input: p.input })),
    null,
    msg.pluginId,
  )
  for (const p of prepared) {
    if (p.changedIds.length > 0) {
      await emitContentEntryUpdated(db, p.id, p.changedIds, actor, p.input.localeId)
    }
  }
  replyApiOk(msg.pluginId, msg.correlationId, updated.map((r) => rowToEntry(r, tableSlug)))
}

export async function handleContentEntriesDeleteMany(
  msg: ApiCallFor<'cms.content.entries.deleteMany'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, ids] = msg.args
  assertContentTableAccess(entry, tableSlug, 'delete')
  const table = await resolveTableBySlug(db, tableSlug)
  // Validate every id belongs to this table BEFORE the transaction so a
  // bad id aborts cleanly without partially-applied deletes. One IN-list
  // read for the whole batch; input order preserves first-bad-id errors.
  const rows = await getDataRowMany(db, ids)
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  for (const id of ids) {
    const row = rowsById.get(id)
    if (!row || row.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
  }
  const result = await softDeleteDataRowMany(db, ids, null)
  const uploadsDir = getPluginUploadsDir(db)
  if (uploadsDir && result.deleted > 0) await refreshPublishedRoutes(db, uploadsDir)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  for (const id of ids) {
    await emitContentEntryDeleted(db, id, actor)
  }
  // Reply shape is part of the plugin API — only `deleted` is exposed.
  replyApiOk(msg.pluginId, msg.correlationId, { deleted: result.deleted })
}

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
  localeId?: string,
): Promise<{ row: DataRow; table: DataTable }> {
  const row = await getDataRow(db, entryId, localeId)
  if (!row) throw new Error(`Entry "${entryId}" not found`)
  const table = await getDataTable(db, row.tableId)
  if (!table) throw new Error(`Table for entry "${entryId}" missing`)
  const field = table.fields.find((f) => f.id === fieldId)
  if (!field) throw new Error(`Field "${fieldId}" not found on table "${table.slug}"`)
  if (field.type !== 'pageTree') {
    throw new Error(`Field "${fieldId}" on table "${table.slug}" is not a pageTree field`)
  }
  return { row, table }
}

export async function handleContentTreeRead(
  msg: ApiCallFor<'cms.content.tree.read'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, options] = msg.args
  const tree = await readPageTree(db, entryId, fieldId, {
    localeId: options.localeId,
    assertAccess: (table) => assertContentTableAccess(entry, table.slug, 'read'),
  })
  replyApiOk(msg.pluginId, msg.correlationId, tree)
}

export async function handleContentTreeMutate(
  msg: ApiCallFor<'cms.content.tree.mutate'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, operations, options] = msg.args
  // Delegate to the shared, actor-agnostic page-tree service. The per-table
  // manifest allowlist is plugin-specific, so it stays here and is injected
  // via `assertAccess`.
  const { tree, affectedNodeIds } = await mutatePageTree(
    db,
    entryId,
    fieldId,
    operations,
    { kind: 'plugin', pluginId: msg.pluginId },
    { localeId: options.localeId, assertAccess: (table) => assertContentTableAccess(entry, table.slug, 'write') },
  )
  replyApiOk(msg.pluginId, msg.correlationId, { tree, affectedNodeIds })
}

export async function handleContentTreeReplace(
  msg: ApiCallFor<'cms.content.tree.replace'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, replacement, options] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId, options.localeId)
  assertContentTableAccess(entry, table.slug, 'write')

  const replacementTree = parsePageNodeTree(
    replacement,
    `entry "${entryId}" field "${fieldId}" replacement`,
  )

  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const nextCells = await applyContentEntryCellsFilter(
    { ...row.cells, [fieldId]: replacementTree },
    { tableSlug: table.slug, entryId, localeId: row.localeId, actor },
  )
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: nextCells, slug: row.slug, localeId: row.localeId },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree replace`)
  await emitContentEntryUpdated(db, entryId, [fieldId], actor, row.localeId)
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}

// ---------------------------------------------------------------------------
// Cross-table — search / snapshot / republishAll
// ---------------------------------------------------------------------------

export async function handleContentSearch(
  msg: ApiCallFor<'cms.content.search'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [query, options] = msg.args
  const localeId = await requestedLocaleId(db, options.localeId)
  const allowedSlugs = new Set((entry.manifest.contentAccess ?? []).filter((access) => access.modes.includes('read')).map((access) => access.table))
  const all = await searchDataRows(db, query, options.limit ?? 50, { localeId, tableSlugs: [...allowedSlugs] })
  const filtered = all
    .filter((r) => allowedSlugs.has(r.tableSlug))
    .map((r) => ({
      id: r.id,
      localeId,
      tableSlug: r.tableSlug,
      tableName: r.tableName,
      slug: r.slug,
      status: r.status,
      updatedAt: r.updatedAt,
    }))
  replyApiOk(msg.pluginId, msg.correlationId, filtered)
}

export async function handleContentSnapshot(
  msg: ApiCallFor<'cms.content.snapshot'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, options] = msg.args
  const row = await getDataRow(db, entryId, options.localeId)
  const table = row ? await getDataTable(db, row.tableId) : null
  if (!row || !table) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  assertContentTableAccess(entry, table.slug, 'read')
  const version = await getPublishedDataRowById(db, entryId, row.localeId)
  if (!version) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  let cells = version.cells
  if (table.kind === 'page') {
    const snapshot = await getPublishedPageSnapshotById(db, entryId, row.localeId, version.siteSnapshotId ?? undefined)
    const page = snapshot?.site.pages.find((candidate) => candidate.id === entryId)
    if (!page) throw new Error('Published page snapshot is missing')
    cells = pageToCells(page)
  }
  const snapshot: PublishedSnapshot = {
    entryId, tableSlug: table.slug, localeId: row.localeId, publicPath: version.publicPath,
    versionNumber: version.versionNumber, slug: version.slug, cells, publishedAt: version.publishedAt,
  }
  replyApiOk(msg.pluginId, msg.correlationId, snapshot)
}

export async function handleContentRepublishAll(
  msg: ApiCallFor<'cms.content.republishAll'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  // `republishAll` operates on the host's full published-pages set —
  // the per-table access check would over-constrain a callee that only
  // wants to flush the publish pipeline. The kernel-of-correctness
  // remains the `cms.content.publish` permission grant.
  const count = await republishAllPages(_db)
  replyApiOk(msg.pluginId, msg.correlationId, { count })
}
