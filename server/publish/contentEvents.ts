/**
 * Centralised emit helpers for the `content.entry.*` plugin event channel.
 *
 * Every code path that creates / updates / deletes a `data_row` should fire
 * the matching event so plugin listeners (SEO assistants, translators, search
 * indexers, etc.) can react. The payload carries an `actor` field so plugins
 * can avoid feedback loops on their own writes.
 *
 * Repository functions stay pure (no hook bus coupling); call sites in
 * `server/handlers/cms/*` and the publish-scheduler call these helpers
 * immediately after a successful mutation.
 */

import type { ContentEntryActor } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import { getDefaultLocale } from '../repositories/localization'
import type { DbClient } from '../db/client'

/** Look up the table slug for a row id — needed to populate the event payload. */
async function resolveTableSlug(db: DbClient, rowId: string): Promise<string | null> {
  const { rows } = await db<{ slug: string }>`
    select data_tables.slug
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId}
    limit 1
  `
  return rows[0]?.slug ?? null
}

export async function emitContentEntryCreated(
  db: DbClient,
  rowId: string,
  actor: ContentEntryActor,
  localeId?: string | null,
): Promise<void> {
  const tableSlug = await resolveTableSlug(db, rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.created', { tableSlug, entryId: rowId, localeId: localeId === undefined ? (await getDefaultLocale(db)).id : localeId, actor })
}

export async function emitContentEntryUpdated(
  db: DbClient,
  rowId: string,
  changedFieldIds: string[],
  actor: ContentEntryActor,
  localeId?: string | null,
): Promise<void> {
  const tableSlug = await resolveTableSlug(db, rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.updated', {
    tableSlug,
    entryId: rowId,
    localeId: localeId === undefined ? (await getDefaultLocale(db)).id : localeId,
    changedFieldIds,
    actor,
  })
}

export async function emitContentEntryDeleted(
  db: DbClient,
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  const tableSlug = await resolveTableSlug(db, rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.deleted', { tableSlug, entryId: rowId, localeId: null, actor })
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
    localeId: string
    actor: ContentEntryActor
  },
): Promise<Record<string, unknown>> {
  return hookBus.applyFilter('content.entry.cells', cells, {
    tableSlug: ctx.tableSlug,
    entryId: ctx.entryId,
    localeId: ctx.localeId,
    actor: ctx.actor,
  })
}
