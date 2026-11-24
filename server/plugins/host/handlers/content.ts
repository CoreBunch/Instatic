/**
 * CMS content handlers — implements every `cms.content.*` api-call.
 *
 * The handlers expose the host's content tables (`data_tables` + `data_rows`)
 * to plugins through a permissioned, per-table-allowlisted surface. The
 * `cms.content.*` permission family is enforced CENTRALLY in `apiDispatch.ts`
 * (driven by `TARGET_PERMISSIONS`) before any handler runs, so each handler:
 *
 *   1. Resolves the targeted table, then decides with `pluginHasContentTableAccess` —
 *      enforces the manifest's `contentAccess[]` allowlist for that table +
 *      mode (this is the per-table check the central permission gate cannot
 *      express). An entry matches by exact slug, or via the `@own-created`
 *      marker when the table's `createdByPluginId` is this plugin.
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
import type { ContentAccessMode } from '@core/plugin-sdk/contentSchemas'
import {
  listDataTables,
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
  scheduleDataRowPublish,
} from '../../../repositories/data'
import { publishDataRow, retractDataRowArtefacts, retractDataRowArtefactsMany } from '../../../publish/publishRow'
import { republishAllPages } from '../../../publish/republish'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import {
  announceEntryCreated,
  announceEntryDeleted,
  announceEntryUpdated,
  applyContentEntryCellsFilter,
} from '../../../publish/contentEvents'
import type { DbClient } from '../../../db/client'
import { pluginHasContentTableAccess } from '../registry'
import { isUniqueViolation } from '../../../db/errors'
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
import { MAIN_SCOPE } from '../../../branches/scope'
import { keepPageStructuralCells, newPageStructuralCells } from '../../../writePolicy/pageStructuralCells'

// Projection helpers (DB → wire shapes) live in `contentProjection.ts`.

interface PluginActor {
  kind: 'plugin'
  pluginId: string
}

/**
 * The table a per-table call names, if the plugin may use `mode` on it.
 *
 * One refusal for a table that does not exist and for one outside the
 * plugin's grant (the permission for the mode, and a `contentAccess` entry
 * declaring it): a call cannot be used to find out which tables exist.
 */
async function tableFor(
  entry: HostPluginRecord,
  db: DbClient,
  tableSlug: string,
  mode: ContentAccessMode,
): Promise<DataTable> {
  const table = await resolveTableBySlug(db, tableSlug).catch(() => null)
  if (!table || !pluginHasContentTableAccess(entry, table, [mode])) {
    throw new Error(
      `Plugin "${entry.manifest.id}" has no "${mode}" access to a table "${tableSlug}": ` +
        'it does not exist, or the granted permissions and contentAccess do not cover it.',
    )
  }
  return table
}

/**
 * The entry a write or publish call is answered with. A plugin that may
 * change a table without reading it is told the entry exists, where and in
 * what state, and nothing of its cells (not those already there, and not
 * what other plugins' filters made of the ones it sent) nor who wrote it.
 */
function entryReply(entry: HostPluginRecord, table: DataTable, row: DataRow): ReturnType<typeof rowToEntry> {
  const projected = rowToEntry(row, table.slug)
  return pluginHasContentTableAccess(entry, table, ['read'])
    ? projected
    : { ...projected, cells: {}, authorUserId: null }
}

/**
 * Run a write that can collide on the table's unique slug, and name the
 * collision. The driver's own message names the index and its columns, which
 * is no answer to give a plugin.
 */
async function namingSlugConflicts<T>(table: DataTable, slug: string | undefined, write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    throw new Error(
      slug ? `The slug "${slug}" is already used in table "${table.slug}".` : `A slug is already used in table "${table.slug}".`,
      { cause: err },
    )
  }
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
  const tables = await listDataTablesWithCounts(db, MAIN_SCOPE)
  const summaries: ContentTableSummary[] = tables
    // Listing a table tells its name, shape and size: that is reading it.
    .filter((t) => pluginHasContentTableAccess(entry, t, ['read']))
    .map((t) => tableSummary(t, t.rowCount))
  replyApiOk(msg.pluginId, msg.correlationId, summaries)
}

export async function handleContentTablesGet(
  msg: ApiCallFor<'cms.content.tables.get'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [slug] = msg.args
  const table = await resolveTableBySlug(db, slug).catch(() => null)
  // One answer for "no such table" and "not yours to read": a plugin does
  // not learn which tables exist beyond its grant.
  if (!table || !pluginHasContentTableAccess(entry, table, ['read'])) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  // One COUNT for this table + the id→slug lookup the relation-field
  // projection needs — no per-table COUNT subselects for tables we don't
  // return.
  const [rowCount, slugLookup] = await Promise.all([
    countDataRows(db, MAIN_SCOPE, table.id),
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
  // Record the creator so the manifest's `@own-created` contentAccess marker
  // can grant this plugin entry access to the table afterwards. The id comes
  // from the host-authenticated worker identity, never from plugin input.
  const created = await createDataTable(db, MAIN_SCOPE, {
    name: input.name,
    slug: input.slug,
    kind: input.kind ?? 'data',
    routeBase: input.routeBase,
    singularLabel: input.singularLabel,
    pluralLabel: input.pluralLabel,
    primaryFieldId: input.primaryFieldId ?? 'title',
    fields,
    createdByPluginId: msg.pluginId,
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
  const table = await tableFor(entry, db, tableSlug, 'read')
  const result = await listDataRowsWithFilter(db, MAIN_SCOPE, table.id, options)
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
  const table = await tableFor(entry, db, tableSlug, 'read')
  const row = await getDataRow(db, MAIN_SCOPE, entryId)
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
  const table = await tableFor(entry, db, tableSlug, 'read')
  const row = await getDataRowBySlug(db, MAIN_SCOPE, table.id, slug)
  replyApiOk(msg.pluginId, msg.correlationId, row ? rowToEntry(row, tableSlug) : null)
}

export async function handleContentEntriesCreate(
  msg: ApiCallFor<'cms.content.entries.create'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, input] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'write')
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  // A plugin may create a page, not set how it is indexed.
  const cells = newPageStructuralCells(table.id, await applyContentEntryCellsFilter(input.cells, {
    scope: MAIN_SCOPE,
    table,
    entryId: 'new',
    actor,
  }))
  const slug = input.slug ?? denormalizeSlug(table, cells)
  const created = await namingSlugConflicts(table, slug, () =>
    createDataRow(db, MAIN_SCOPE, { tableId: table.id, cells, slug }, null, msg.pluginId),
  )
  await announceEntryCreated(table, created.id, actor)
  replyApiOk(msg.pluginId, msg.correlationId, entryReply(entry, table, created))
}

export async function handleContentEntriesUpdate(
  msg: ApiCallFor<'cms.content.entries.update'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, entryId, patch] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'write')
  const existing = await getDataRow(db, MAIN_SCOPE, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
  const filteredCells = await applyContentEntryCellsFilter(mergedCells, {
    scope: MAIN_SCOPE,
    table,
    entryId,
    actor,
  })
  const changedIds = diffCells(existing.cells, filteredCells)
  // `denormalizeSlug` returns '' for tables without a slug field (or when the
  // slug cell is cleared); fall back to the existing slug so an update never
  // silently blanks the row's public path.
  const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
  const updated = await namingSlugConflicts(table, nextSlug || existing.slug, () =>
    saveDataRowDraft(
      db,
      MAIN_SCOPE,
      entryId,
      // A plugin edits a page's content; the page's access rule and head settings stay as stored.
      { cells: keepPageStructuralCells(existing, filteredCells), slug: nextSlug || existing.slug },
      null,
      msg.pluginId,
    ),
  )
  if (!updated) throw new Error(`Entry "${entryId}" could not be updated`)
  if (changedIds.length > 0) {
    await announceEntryUpdated(table, entryId, changedIds, actor)
  }
  replyApiOk(msg.pluginId, msg.correlationId, entryReply(entry, table, updated))
}

export async function handleContentEntriesDelete(
  msg: ApiCallFor<'cms.content.entries.delete'>,
  entry: HostPluginRecord,
  db: DbClient,
  uploadsDir: string | undefined,
): Promise<void> {
  const [tableSlug, entryId] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'delete')
  const existing = await getDataRow(db, MAIN_SCOPE, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const deleted = await softDeleteDataRow(db, MAIN_SCOPE, entryId)
  if (deleted) {
    const wasPublished = deleted.status === 'published'
    // Layer A reads the baked slot with no DB awareness: drop the row's own
    // page and, when it was public, the baked pages that list its table.
    if (uploadsDir) {
      await retractDataRowArtefacts(db, uploadsDir, deleted, { wasPublished }).catch((err) => {
        console.error(`[plugin:${msg.pluginId}] failed to remove artefacts for deleted entry`, entryId, err)
      })
    }
    // A published row's route is retracted — invalidate the render cache.
    if (wasPublished) await bumpPublishVersionSerialized()
    await announceEntryDeleted(table, entryId, { kind: 'plugin', pluginId: msg.pluginId })
  }
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}

export async function handleContentEntriesPublish(
  msg: ApiCallFor<'cms.content.entries.publish'>,
  entry: HostPluginRecord,
  db: DbClient,
  uploadsDir: string | undefined,
): Promise<void> {
  const [tableSlug, entryId, options] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'publish')
  const existing = await getDataRow(db, MAIN_SCOPE, entryId)
  if (!existing || existing.tableId !== table.id) {
    throw new Error(`Entry "${entryId}" not found in table "${tableSlug}"`)
  }
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  if (options.scheduledFor) {
    const scheduled = await scheduleDataRowPublish(db, MAIN_SCOPE, entryId, options.scheduledFor, null)
    if (!scheduled) throw new Error(`Entry "${entryId}" could not be scheduled`)
    await announceEntryUpdated(table, entryId, ['status'], actor)
    replyApiOk(msg.pluginId, msg.correlationId, entryReply(entry, table, scheduled))
    return
  }

  const result = await publishDataRow(db, entryId, null, uploadsDir)
  await announceEntryUpdated(table, entryId, ['status'], actor)
  replyApiOk(msg.pluginId, msg.correlationId, entryReply(entry, table, result.row))
}

// ── Bulk ─────────────────────────────────────────────────────────────────

export async function handleContentEntriesCreateMany(
  msg: ApiCallFor<'cms.content.entries.createMany'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, inputs] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'write')
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  // Apply the cells filter per-input before the transaction. The filter
  // runs INSIDE the same plugin's worker; running it inside the per-row
  // transaction would tie up the DB connection.
  const prepared = await Promise.all(inputs.map(async (input) => {
    const cells = newPageStructuralCells(table.id, await applyContentEntryCellsFilter(input.cells, { scope: MAIN_SCOPE, table, entryId: 'new', actor }))
    const slug = input.slug ?? denormalizeSlug(table, cells)
    return { tableId: table.id, cells, slug }
  }))
  const created = await namingSlugConflicts(table, undefined, () =>
    createDataRowMany(db, MAIN_SCOPE, prepared, null, msg.pluginId),
  )
  for (const row of created) {
    await announceEntryCreated(table, row.id, actor)
  }
  replyApiOk(msg.pluginId, msg.correlationId, created.map((r) => entryReply(entry, table, r)))
}

export async function handleContentEntriesUpdateMany(
  msg: ApiCallFor<'cms.content.entries.updateMany'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [tableSlug, updates] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'write')
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }

  // Read every targeted row in ONE IN-list query, then apply filter + diff
  // per-row before the transaction. Iterating `updates` in input order
  // preserves the first-bad-id error semantics of the old per-row reads.
  const existingRows = await getDataRowMany(db, MAIN_SCOPE, updates.map((u) => u.id))
  const existingById = new Map(existingRows.map((row) => [row.id, row]))
  const prepared: Array<{ id: string; input: { cells: Record<string, unknown>; slug: string }; changedIds: string[] }> = []
  for (const { id, patch } of updates) {
    const existing = existingById.get(id)
    if (!existing || existing.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
    const mergedCells = patch.cells ? { ...existing.cells, ...patch.cells } : existing.cells
    const filteredCells = await applyContentEntryCellsFilter(mergedCells, {
      scope: MAIN_SCOPE,
      table,
      entryId: id,
      actor,
    })
    const changedIds = diffCells(existing.cells, filteredCells)
    const nextSlug = patch.slug ?? denormalizeSlug(table, filteredCells)
    prepared.push({
      id,
      input: { cells: keepPageStructuralCells(existing, filteredCells), slug: nextSlug || existing.slug },
      changedIds,
    })
  }
  const updated = await namingSlugConflicts(table, undefined, () =>
    saveDataRowDraftMany(
      db,
      MAIN_SCOPE,
      prepared.map((p) => ({ id: p.id, input: p.input })),
      null,
      msg.pluginId,
    ),
  )
  for (const p of prepared) {
    if (p.changedIds.length > 0) {
      await announceEntryUpdated(table, p.id, p.changedIds, actor)
    }
  }
  replyApiOk(msg.pluginId, msg.correlationId, updated.map((r) => entryReply(entry, table, r)))
}

export async function handleContentEntriesDeleteMany(
  msg: ApiCallFor<'cms.content.entries.deleteMany'>,
  entry: HostPluginRecord,
  db: DbClient,
  uploadsDir: string | undefined,
): Promise<void> {
  const [tableSlug, ids] = msg.args
  const table = await tableFor(entry, db, tableSlug, 'delete')
  // Validate every id belongs to this table BEFORE the transaction so a
  // bad id aborts cleanly without partially-applied deletes. One IN-list
  // read for the whole batch; input order preserves first-bad-id errors.
  const rows = await getDataRowMany(db, MAIN_SCOPE, ids)
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  for (const id of ids) {
    const row = rowsById.get(id)
    if (!row || row.tableId !== table.id) {
      throw new Error(`Entry "${id}" not found in table "${tableSlug}"`)
    }
  }
  const result = await softDeleteDataRowMany(db, MAIN_SCOPE, ids, null)
  // Layer A mirror of the cache invalidation below: the deleted rows' own
  // baked pages go, and so do the baked pages that listed the published ones.
  if (uploadsDir) {
    const retracted = rows.map((row) => ({ ...row, wasPublished: row.status === 'published' }))
    await retractDataRowArtefactsMany(db, uploadsDir, retracted).catch((err) => {
      console.error(`[plugin:${msg.pluginId}] failed to remove artefacts for deleted entries`, err)
    })
  }
  // Published rows' routes were retracted — one cache invalidation per batch.
  if (result.publishedDeleted > 0) await bumpPublishVersionSerialized()
  const actor: PluginActor = { kind: 'plugin', pluginId: msg.pluginId }
  for (const id of ids) {
    await announceEntryDeleted(table, id, actor)
  }
  // Reply shape is part of the plugin API — only `deleted` is exposed.
  replyApiOk(msg.pluginId, msg.correlationId, { deleted: result.deleted })
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
  // Search results carry only `tableSlug`, so resolve the READABLE set
  // (declared slugs + own-created tables, with `read`) against the table
  // list — tiny, and the only way to honor the `@own-created` marker here.
  const accessibleSlugs = new Set(
    (await listDataTables(db, MAIN_SCOPE))
      .filter((t) => pluginHasContentTableAccess(entry, t, ['read']))
      .map((t) => t.slug),
  )
  const all = await searchDataRows(db, MAIN_SCOPE, query, limit)
  const filtered = all
    .filter((r) => accessibleSlugs.has(r.tableSlug))
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
  const row = await getDataRow(db, MAIN_SCOPE, entryId)
  if (!row) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  const table = await getDataTable(db, MAIN_SCOPE, row.tableId)
  // An entry of a table the plugin may not read is answered like an entry
  // that does not exist: the id does not reveal which table holds it.
  if (!table || !pluginHasContentTableAccess(entry, table, ['read'])) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }

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
      and data_rows.branch_id = 'main'
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
