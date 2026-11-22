/**
 * Content entry lifecycle events — the plugin-facing `content.entry.*`
 * hooks, emitted by every admin/plugin surface that creates, updates, or
 * deletes a data row, plus the `content.entry.cells` filter that lets
 * plugins normalize cells before persistence.
 *
 * Hooks describe the LIVE site: a write on a branch is invisible to plugins
 * until it is merged into main, so every emitter is a no-op off `main`. The
 * lookups below therefore only ever address main rows, whose physical and
 * logical ids coincide.
 */
import type { ContentEntryActor } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import type { DbClient } from '../db/client'
import { isMainScope, type BranchScope } from '../branches/scope'
import { entryCellsFilterRecipients, entryEventRecipients } from '../plugins/host/hookAccess'
import type { ContentAccessTable } from '../plugins/host/registry'
import { keepPageStructuralCells } from '../writePolicy/pageStructuralCells'

/**
 * The table of a main row id: its slug for the event payload, and what
 * decides which plugins may hear about its entries.
 */
async function resolveTable(db: DbClient, rowId: string): Promise<ContentAccessTable | null> {
  const { rows } = await db<{ slug: string; created_by_plugin_id: string | null }>`
    select data_tables.slug, data_tables.created_by_plugin_id
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId}
      and data_rows.branch_id = 'main'
    limit 1
  `
  const row = rows[0]
  return row ? { slug: row.slug, createdByPluginId: row.created_by_plugin_id } : null
}

/**
 * Tell plugins an entry of `table` was created. Only plugins whose content
 * access lets them read that table hear it (`HOST_EVENT_RULES`); the same
 * holds for the two announcements below.
 */
export async function announceEntryCreated(
  table: ContentAccessTable,
  entryId: string,
  actor: ContentEntryActor,
): Promise<void> {
  await hookBus.emit(
    'content.entry.created',
    { tableSlug: table.slug, entryId, actor },
    entryEventRecipients('content.entry.created', table),
  )
}

export async function announceEntryUpdated(
  table: ContentAccessTable,
  entryId: string,
  changedFieldIds: string[],
  actor: ContentEntryActor,
): Promise<void> {
  await hookBus.emit(
    'content.entry.updated',
    { tableSlug: table.slug, entryId, changedFieldIds, actor },
    entryEventRecipients('content.entry.updated', table),
  )
}

export async function announceEntryDeleted(
  table: ContentAccessTable,
  entryId: string,
  actor: ContentEntryActor,
): Promise<void> {
  await hookBus.emit(
    'content.entry.deleted',
    { tableSlug: table.slug, entryId, actor },
    entryEventRecipients('content.entry.deleted', table),
  )
}

export async function emitContentEntryCreated(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  if (!isMainScope(scope)) return
  const table = await resolveTable(db, rowId)
  if (table) await announceEntryCreated(table, rowId, actor)
}

export async function emitContentEntryUpdated(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  changedFieldIds: string[],
  actor: ContentEntryActor,
): Promise<void> {
  if (!isMainScope(scope)) return
  const table = await resolveTable(db, rowId)
  if (table) await announceEntryUpdated(table, rowId, changedFieldIds, actor)
}

export async function emitContentEntryDeleted(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  if (!isMainScope(scope)) return
  const table = await resolveTable(db, rowId)
  if (table) await announceEntryDeleted(table, rowId, actor)
}

/**
 * Run the `content.entry.cells` filter pipeline before an entry is saved.
 *
 * A plugin's handler sees the cells and what it returns is persisted, so it
 * runs only for a plugin whose content access lets it both read and write
 * `table` (`HOST_FILTER_RULES`). Every other registered handler is passed
 * over for this entry, exactly as if it had not registered.
 *
 * It runs for saves on a branch too: a merge brings branch rows to `main`
 * without saving them again, so a plugin that validates or normalises on
 * save must see them where they are written. The context says so with
 * `branch: true` (which branch is not the plugin's to know); an entry id
 * then names a row of that branch, not of `main`. Entry events, by contrast,
 * stay main-only.
 */
export async function applyContentEntryCellsFilter(
  cells: Record<string, unknown>,
  ctx: {
    scope: BranchScope
    table: ContentAccessTable & { id: string }
    entryId: string
    actor: ContentEntryActor
  },
): Promise<Record<string, unknown>> {
  const filtered = await hookBus.applyFilter(
    'content.entry.cells',
    cells,
    { tableSlug: ctx.table.slug, entryId: ctx.entryId, actor: ctx.actor, branch: !isMainScope(ctx.scope) },
    entryCellsFilterRecipients(ctx.table),
  )
  // Filters may edit content even during an owner's save. Only the caller
  // can supply the page's access rule and head settings.
  return filtered === cells ? cells : keepPageStructuralCells({ tableId: ctx.table.id, cells }, filtered)
}
