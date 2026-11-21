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

/** Look up the table slug for a main row id — needed to populate the event payload. */
async function resolveTableSlug(db: DbClient, rowId: string): Promise<string | null> {
  const { rows } = await db<{ slug: string }>`
    select data_tables.slug
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId}
      and data_rows.branch_id = 'main'
    limit 1
  `
  return rows[0]?.slug ?? null
}

export async function emitContentEntryCreated(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  if (!isMainScope(scope)) return
  const tableSlug = await resolveTableSlug(db, rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.created', { tableSlug, entryId: rowId, actor })
}

export async function emitContentEntryUpdated(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  changedFieldIds: string[],
  actor: ContentEntryActor,
): Promise<void> {
  if (!isMainScope(scope)) return
  const tableSlug = await resolveTableSlug(db, rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.updated', {
    tableSlug,
    entryId: rowId,
    changedFieldIds,
    actor,
  })
}

export async function emitContentEntryDeleted(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  if (!isMainScope(scope)) return
  const tableSlug = await resolveTableSlug(db, rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.deleted', { tableSlug, entryId: rowId, actor })
}

/**
 * Run the `content.entry.cells` filter pipeline. Plugin handlers (the
 * `cms.content.*` surface) call this directly; admin CMS handlers can
 * call it too if they want plugin-driven normalization.
 */
export async function applyContentEntryCellsFilter(
  cells: Record<string, unknown>,
  ctx: {
    tableSlug: string
    entryId: string
    actor: ContentEntryActor
  },
): Promise<Record<string, unknown>> {
  return hookBus.applyFilter('content.entry.cells', cells, {
    tableSlug: ctx.tableSlug,
    entryId: ctx.entryId,
    actor: ctx.actor,
  })
}
