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
import { applyTreeOperation, parsePageNodeTree } from '@core/page-tree'
import { hookBus } from '@core/plugins/hookBus'
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
  scheduleDataRowPublish,
} from '../../../repositories/data'
import { publishDataRow } from '../../../publish/publishRow'
import { ensureDefaultEntryTemplate } from '../../../publish/templateSeeding'
import { republishAllPages } from '../../../publish/republish'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import { applyContentEntryCellsFilter } from '../../../publish/contentEvents'
import type { DbClient } from '../../../db/client'
import { assertContentTableAccess } from '../registry'
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

async function emitEntryCreated(tableSlug: string, entryId: string, actor: PluginActor): Promise<void> {
  await hookBus.emit('content.entry.created', { tableSlug, entryId, actor })
}

async function emitEntryUpdated(
  tableSlug: string,
  entryId: string,
  changedFieldIds: string[],
  actor: PluginActor,
): Promise<void> {
  await hookBus.emit('content.entry.updated', {
    tableSlug,
    entryId,
    changedFieldIds,
    actor,
  })
}

async function emitEntryDeleted(tableSlug: string, entryId: string, actor: PluginActor): Promise<void> {
  await hookBus.emit('content.entry.deleted', { tableSlug, entryId, actor })
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
  // postType tables need a default entry template so the public route
  // `/<route-base>/<row-slug>` resolves immediately (no-op for `data` kind).
  await ensureDefaultEntryTemplate(db, created, null)
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
  const [tableSlug, entryId] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const row = await getDataRow(db, entryId)
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
  const [tableSlug, slug] = msg.args
  assertContentTableAccess(entry, tableSlug, 'read')
  const table = await resolveTableBySlug(db, tableSlug)
  const row = await getDataRowBySlug(db, table.id, slug)
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
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const cells = await applyContentEntryCellsFilter(input.cells, {
    tableSlug,
    entryId: 'new',
    actor,
  })
  const slug = input.slug ?? denormalizeSlug(table, cells)
  const created = await createDataRow(
    db,
    { tableId: table.id, cells, slug },
    null,
    msg.pluginId,
  )
  await emitEntryCreated(tableSlug, created.id, actor)
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
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
  const filteredCells = await applyContentEntryCellsFilter(mergedCells, {
    tableSlug,
    entryId,
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
    { cells: filteredCells, slug: nextSlug || existing.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated`)
  if (changedIds.length > 0) {
    await emitEntryUpdated(tableSlug, entryId, changedIds, actor)
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
    // A published row's route is retracted — invalidate the render cache.
    if (deleted.status === 'published') await bumpPublishVersionSerialized()
    await emitEntryDeleted(tableSlug, entryId, { kind: 'plugin', pluginId: msg.pluginId })
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
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  if (options.scheduledFor) {
    const scheduled = await scheduleDataRowPublish(db, entryId, options.scheduledFor, null)
    if (!scheduled) throw new Error(`Entry "${entryId}" could not be scheduled`)
    await emitEntryUpdated(tableSlug, entryId, ['status'], actor)
    replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(scheduled, tableSlug))
    return
  }

  const result = await publishDataRow(db, entryId, null)
  await emitEntryUpdated(tableSlug, entryId, ['status'], actor)
  replyApiOk(msg.pluginId, msg.correlationId, rowToEntry(result.row, tableSlug))
}

export async function handleContentEntriesMoveTable(
  msg: ApiCallFor<'cms.content.entries.moveTable'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, targetSlug] = msg.args
  assertContentTableAccess(entry, tableSlug, 'write')
  assertContentTableAccess(entry, targetSlug, 'write')
  const source = await resolveTableBySlug(db, tableSlug)
  const target = await resolveTableBySlug(db, targetSlug)
  const existing = await getDataRow(db, entryId)
  if (!existing || existing.tableId !== source.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const result = await updateDataRowTable(db, entryId, target.id, null)
  if (!result.ok) throw new Error(`moveToTable failed: ${result.reason}`)
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  await emitEntryUpdated(tableSlug, entryId, ['tableId'], actor)
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
    const cells = await applyContentEntryCellsFilter(input.cells, { tableSlug, entryId: 'new', actor })
    const slug = input.slug ?? denormalizeSlug(table, cells)
    return { tableId: table.id, cells, slug }
  }))
  const created = await createDataRowMany(db, prepared, null, msg.pluginId)
  for (const row of created) {
    await emitEntryCreated(tableSlug, row.id, actor)
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
  const existingRows = await getDataRowMany(db, updates.map((u) => u.id))
  const existingById = new Map(existingRows.map((row) => [row.id, row]))
  const prepared: Array<{ id: string; input: { cells: Record<string, unknown>; slug: string }; changedIds: string[] }> = []
  for (const { id, patch } of updates) {
    const existing = existingById.get(id)
    if (!existing || existing.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
    const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
    const filteredCells = await applyContentEntryCellsFilter(mergedCells, {
      tableSlug,
      entryId: id,
      actor,
    })
    const changedIds = diffCells(existing.cells, filteredCells)
    const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
    prepared.push({
      id,
      input: { cells: filteredCells, slug: nextSlug || existing.slug },
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
      await emitEntryUpdated(tableSlug, p.id, p.changedIds, actor)
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
  // Published rows' routes were retracted — one cache invalidation per batch.
  if (result.publishedDeleted > 0) await bumpPublishVersionSerialized()
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  for (const id of ids) {
    await emitEntryDeleted(tableSlug, id, actor)
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
): Promise<{ row: DataRow; table: DataTable }> {
  const row = await getDataRow(db, entryId)
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
  const [entryId, fieldId] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)
  assertContentTableAccess(entry, table.slug, 'read')
  const tree = row.cells[fieldId] ?? null
  replyApiOk(msg.pluginId, msg.correlationId, tree)
}

export async function handleContentTreeMutate(
  msg: ApiCallFor<'cms.content.tree.mutate'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, operations] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)
  assertContentTableAccess(entry, table.slug, 'write')

  // Deep-clone so the dispatcher's in-place mutations don't surface on the
  // shared row reference held by `getDataRow`'s cache (the row's cells
  // object would otherwise be shared with the original DB read).
  const initial = row.cells[fieldId]
  if (!initial || typeof initial !== 'object') {
    throw new Error(`Field "${fieldId}" on entry "${entryId}" is empty — cannot mutate a missing tree`)
  }
  let tree = parsePageNodeTree(
    structuredClone(initial),
    `entry "${entryId}" field "${fieldId}"`,
  )

  const affectedNodeIds: string[] = []
  for (const op of operations) {
    const result = applyTreeOperation(tree, op)
    tree = result.tree
    affectedNodeIds.push(...result.affectedNodeIds)
  }
  parsePageNodeTree(tree, `entry "${entryId}" field "${fieldId}" after mutation`)

  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const nextCells = await applyContentEntryCellsFilter(
    { ...row.cells, [fieldId]: tree },
    { tableSlug: table.slug, entryId, actor },
  )
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: nextCells, slug: row.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree mutation`)
  await emitEntryUpdated(table.slug, entryId, [fieldId], actor)
  replyApiOk(msg.pluginId, msg.correlationId, { tree, affectedNodeIds })
}

export async function handleContentTreeReplace(
  msg: ApiCallFor<'cms.content.tree.replace'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [entryId, fieldId, replacement] = msg.args
  const { row, table } = await resolvePageTreeField(db, entryId, fieldId)
  assertContentTableAccess(entry, table.slug, 'write')

  const replacementTree = parsePageNodeTree(
    replacement,
    `entry "${entryId}" field "${fieldId}" replacement`,
  )

  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const nextCells = await applyContentEntryCellsFilter(
    { ...row.cells, [fieldId]: replacementTree },
    { tableSlug: table.slug, entryId, actor },
  )
  const updated = await saveDataRowDraft(
    db,
    entryId,
    { cells: nextCells, slug: row.slug },
    null,
    msg.pluginId,
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated after tree replace`)
  await emitEntryUpdated(table.slug, entryId, [fieldId], actor)
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
  const [query, limit] = msg.args
  const allowedSlugs = new Set((entry.manifest.contentAccess ?? []).map((e) => e.table))
  const all = await searchDataRows(db, query, limit)
  const filtered = all
    .filter((r) => allowedSlugs.has(r.tableSlug))
    .map((r) => ({
      id: r.id,
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
  const [entryId] = msg.args
  const row = await getDataRow(db, entryId)
  if (!row) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  const table = await getDataTable(db, row.tableId)
  if (!table) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  assertContentTableAccess(entry, table.slug, 'read')

  const { rows } = await db<{
    version_number: number
    cells_json: Record<string, unknown>
    slug: string
    published_at: string | Date
  }>`
    select data_row_versions.version_number,
           data_row_versions.cells_json,
           data_row_versions.slug,
           data_row_versions.published_at
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    where data_rows.id = ${entryId}
      and data_rows.deleted_at is null
    limit 1
  `
  if (!rows[0]) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  const snap: PublishedSnapshot = {
    entryId: row.id,
    tableSlug: table.slug,
    versionNumber: rows[0].version_number,
    slug: rows[0].slug,
    cells: rows[0].cells_json,
    publishedAt: typeof rows[0].published_at === 'string'
      ? rows[0].published_at
      : rows[0].published_at.toISOString(),
  }
  replyApiOk(msg.pluginId, msg.correlationId, snap)
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
