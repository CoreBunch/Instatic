/**
 * Single-row write mutations for data rows.
 *
 *   createDataRow        — insert a new draft
 *   saveDataRowDraft     — overwrite the draft cells and slug
 *   softDeleteDataRow    — set deleted_at
 *   updateDataRowTable   — move a row to another table (rejects on slug conflict)
 *   updateDataRowStatus  — flip between draft / unpublished
 *   updateDataRowAuthor  — reassign the author user id
 *
 * Mutations (other than soft-delete) always RETURN id only, then re-read the
 * hydrated row through `getDataRow` so callers receive consistently populated
 * user references. Soft-delete is the exception: a soft-deleted row is filtered
 * out by `getDataRow`'s `deleted_at is null` clause, so the row is mapped
 * directly from RETURNING. Because RETURNING carries no user-ref joins, the
 * result is a narrow `DeletedRowSummary` (not a `DataRow`) — the delete callers
 * only consume id / tableId / slug / status / deletedAt.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../../db/client'
import type { DataRow, DataRowCells, DeletedRowSummary } from '@core/data/schemas'
import { getLocalizablePropertyKeys, splitLocalizedCells, updateTranslationMetadata } from '@core/localization'
import { registry } from '@core/module-engine'
import { bumpPublishVersion, withPublishLock } from '../../../publish/publishState'
import { type InsertDataRowInput, type UpdateDataRowDraftInput } from './mapper'
import { isoDateOrNull } from '@core/utils/isoDate'
import { deepEqual } from '@core/utils/deepEqual'
import { getDataRow, listDataRows } from './read'
import { localizableComponentParameterIds } from '@core/visualComponents'
import { visualComponentFromRow } from '@core/data/componentFromRow'
import { notifyRowWrite, serializeCollabAwareWrite } from '../../rowWriteEvents'
import { getDataTable } from '../tables'
import { changeRowFieldLocalizationInTx } from '../tableFieldLocalization'
import { getDefaultLocale, resolveContentLocale, listContentLocalizations, LocalizationError, saveContentLocalizationDraft, setContentLocalizationAvailability } from '../../localization'


async function localizationPropertyPolicy(db: DbClient) {
  const components = new Map((await listDataRows(db, 'components')).flatMap((row) => {
    const component = visualComponentFromRow({ ...row, cells: row.sharedCells })
    return component ? [[component.id, component] as const] : []
  }))
  return (node: { moduleId: string; props: Record<string, unknown> }, key: string): boolean | ReadonlySet<string> => {
    if (node.moduleId === 'base.visual-component-ref' && key === 'propOverrides') {
      const component = components.get(String(node.props.componentId ?? ''))
      return component ? localizableComponentParameterIds(component) : false
    }
    const definition = registry.get(node.moduleId)
    return definition ? getLocalizablePropertyKeys(definition.schema).has(key) : false
  }
}

async function assertDraftSlugAvailable(db: DbClient, tableId: string, rowId: string, localeId: string, slug: string): Promise<void> {
  if (!slug) return
  const { rows } = await db<{ row_id: string }>`
    select localizations.row_id from data_row_localizations localizations
    join data_rows on data_rows.id = localizations.row_id
    where data_rows.table_id = ${tableId} and data_rows.deleted_at is null
      and localizations.locale_id = ${localeId} and localizations.slug = ${slug}
      and localizations.row_id <> ${rowId}
    limit 1
  `
  if (rows[0]) throw new LocalizationError('This URL slug is already used in this language', 'slug')
}

type UpdateDataRowTableResult =
  | { ok: true; row: DataRow }
  | { ok: false; reason: 'row_not_found' | 'table_not_found' | 'slug_conflict' | 'unsupported_table' }

export async function createDataRow(
  db: DbClient,
  input: InsertDataRowInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<DataRow> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      const created = await db.transaction((tx) => createDataRow(
        tx,
        input,
        actorUserId,
        pluginActorId,
        { collabInternal: true },
      ))
      notifyRowWrite({ tableId: created.tableId, rowIds: [created.id], kind: 'create', localeId: created.localeId, sharedChanged: true })
      return created
    })
  }
  const locale = await resolveContentLocale(db, input.localeId)
  const table = await getDataTable(db, input.tableId)
  if (!table) throw new Error('Data table not found')
  const id = input.id ?? nanoid()
  await assertDraftSlugAvailable(db, input.tableId, id, locale.id, input.slug)
  const split = splitLocalizedCells(table.fields, {}, {}, input.cells, {}, {
    allowStructureChanges: locale.isDefault,
    canLocalizeProperty: await localizationPropertyPolicy(db),
  })
  await db`
    insert into data_rows (
      id,
      table_id,
      cells_json,
      slug,
      author_user_id,
      created_by_user_id,
      updated_by_user_id,
      plugin_actor_id
    )
    values (
      ${id},
      ${input.tableId},
      ${split.sharedCells},
      ${''},
      ${actorUserId},
      ${actorUserId},
      ${actorUserId},
      ${pluginActorId}
    )
  `
  await saveContentLocalizationDraft(db, id, locale.id, { cells: split.localeCells, slug: input.slug }, actorUserId)
  const created = await getDataRow(db, id, locale.id)
  if (!created) throw new Error('data row was created but could not be re-read')
  return created
}

export async function saveDataRowDraft(
  db: DbClient,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<DataRow | null> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      const before = await getDataRow(db, rowId, input.localeId)
      const row = await db.transaction((tx) => saveDataRowDraft(
        tx,
        rowId,
        input,
        actorUserId,
        pluginActorId,
        { collabInternal: true },
      ))
      if (row) notifyRowWrite({ tableId: row.tableId, rowIds: [row.id], kind: 'update', localeId: row.localeId, sharedChanged: !deepEqual(before?.sharedCells, row.sharedCells) })
      return row
    })
  }
  const updated = await updateDataRowDraftCells(db, rowId, input, actorUserId, pluginActorId)
  return updated ? getDataRow(db, rowId, input.localeId) : null
}

/**
 * The write half of `saveDataRowDraft`, without the hydrated re-read. The
 * roster reconcilers (PUT /pages, PUT /components) discard the row anyway —
 * re-reading every saved row through the user-ref joins doubled their query
 * count per save. Returns whether a (non-deleted) row matched.
 */
export async function updateDataRowDraftCells(
  db: DbClient,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<boolean> {
  const locale = await resolveContentLocale(db, input.localeId)
  const previous = await getDataRow(db, rowId, locale.id)
  if (!previous) return false
  const table = await getDataTable(db, previous.tableId)
  if (!table) return false
  const slug = input.slug ?? (typeof input.cells.slug === 'string' ? input.cells.slug : previous.slug)
  await assertDraftSlugAvailable(db, previous.tableId, rowId, locale.id, slug)
  const inputCells = Object.hasOwn(input.cells, 'slug') ? { ...input.cells, slug } : input.cells
  const split = splitLocalizedCells(table.fields, previous.sharedCells, previous.cells, inputCells, previous.localization?.cells ?? {}, {
    allowStructureChanges: locale.isDefault,
    canLocalizeProperty: await localizationPropertyPolicy(db),
  })
  const source = locale.isDefault ? previous : await getDataRow(db, rowId)
  const translationMeta = locale.isDefault ? {} : updateTranslationMetadata(
    source?.cells ?? {}, previous.localization?.cells ?? {}, split.localeCells,
    previous.localization?.translationMeta ?? {},
  )
  const { rows } = await db<{ id: string }>`
    update data_rows
    set cells_json = ${split.sharedCells},
        slug = '',
        updated_by_user_id = ${actorUserId},
        plugin_actor_id = ${pluginActorId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  if (rows.length > 0) {
    await saveContentLocalizationDraft(db, rowId, locale.id, { cells: split.localeCells, slug, translationMeta }, actorUserId)
  }
  return rows.length > 0
}

/**
 * Revive a soft-deleted row with fresh draft cells — the roster reconcile's
 * answer to a client re-submitting an id it previously reaped (undo of a
 * delete). Clears `deleted_at` and overwrites cells/slug; the row keeps its
 * pre-delete status (publish state transitions stay with the publish flow).
 */
export async function resurrectDataRow(
  db: DbClient,
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
): Promise<void> {
  await db`
    update data_rows
    set deleted_at = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is not null
  `
  await updateDataRowDraftCells(db, rowId, input, actorUserId)
}

/**
 * Idempotent draft write by id — update a live row, RESURRECT a soft-deleted
 * one, or create it fresh. The three-way decision the collab relay needs: a
 * row the roster sweep soft-deleted and a peer then restored (undo of a page
 * delete) still occupies its primary key, so a plain insert would conflict —
 * exactly the flow `apply.ts` handles for HTTP batches, here for one row.
 */
export async function upsertDataRowDraft(
  db: DbClient,
  input: InsertDataRowInput & { id: string },
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<void> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      const before = await getDataRow(db, input.id, input.localeId)
      await db.transaction((tx) => upsertDataRowDraft(tx, input, actorUserId, { collabInternal: true }))
      const after = await getDataRow(db, input.id, input.localeId)
      notifyRowWrite({ tableId: input.tableId, rowIds: [input.id], kind: 'update', localeId: after?.localeId, sharedChanged: !deepEqual(before?.sharedCells, after?.sharedCells) })
    })
  }
  const draft = { cells: input.cells, slug: input.slug, localeId: input.localeId }
  const { rows: identities } = await db<{ table_id: string }>`select table_id from data_rows where id = ${input.id}`
  if (identities[0] && identities[0].table_id !== input.tableId) throw new LocalizationError('This content identity belongs to another collection', 'tableId')
  const updated = await updateDataRowDraftCells(db, input.id, draft, actorUserId)
  if (updated) return
  const { rows } = await db<{ id: string }>`
    select id from data_rows where id = ${input.id} and deleted_at is not null
  `
  if (rows.length > 0) {
    await resurrectDataRow(db, input.id, draft, actorUserId)
  } else {
    await createDataRow(db, input, actorUserId, null, { collabInternal: true })
  }
}

/**
 * Slug-only write — the second phase of the roster reconcile's two-phase
 * slug update (see rows/reconcile.ts). The row's cells and audit columns were
 * already written by `updateDataRowDraftCells` in the same transaction; this
 * just moves the row off the placeholder slug onto its final one.
 */
export async function updateDataRowSlug(
  db: DbClient,
  rowId: string,
  slug: string,
  localeId?: string,
): Promise<void> {
  const locale = await resolveContentLocale(db, localeId)
  const row = await getDataRow(db, rowId, locale.id)
  if (!row) return
  await assertDraftSlugAvailable(db, row.tableId, rowId, locale.id, slug)
  await db`
    update data_row_localizations
    set slug = ${slug}
    where row_id = ${rowId} and locale_id = ${locale.id}
  `
}

/** CRDT shared documents persist only logical structure and shared values. */
export async function upsertSharedDataRowDraft(
  db: DbClient,
  input: { id: string; tableId: string; cells: DataRowCells },
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<void> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(async () => {
      await upsertSharedDataRowDraft(db, input, actorUserId, { collabInternal: true })
      notifyRowWrite({ tableId: input.tableId, rowIds: [input.id], kind: 'update' })
    })
  }
  const { rows } = await db<{ id: string }>`
    insert into data_rows (id, table_id, cells_json, slug, author_user_id, created_by_user_id, updated_by_user_id)
    values (${input.id}, ${input.tableId}, ${input.cells}, '', ${actorUserId}, ${actorUserId}, ${actorUserId})
    on conflict (id) do update set cells_json = excluded.cells_json, slug = '',
      deleted_at = null, updated_by_user_id = excluded.updated_by_user_id, updated_at = current_timestamp
    where data_rows.table_id = excluded.table_id
    returning id
  `
  if (!rows[0]) throw new LocalizationError('This content identity belongs to another collection', 'tableId')
}

/**
 * Soft-delete is the one mutation that returns the row directly from
 * RETURNING rather than re-reading via `getDataRow`: the row now has
 * `deleted_at` set, so `getDataRow`'s `deleted_at is null` filter would mask
 * it. RETURNING carries no user-ref joins, so the result cannot be a hydrated
 * `DataRow` — it is a narrow `DeletedRowSummary` (id / tableId / slug / status /
 * deletedAt), which is all the soft-delete callers consume (audit logging +
 * artefact pruning).
 */
export async function softDeleteDataRow(
  db: DbClient,
  rowId: string,
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean } = {},
): Promise<DeletedRowSummary | null> {
  if (!opts.collabInternal) {
    return serializeCollabAwareWrite(() => withPublishLock(async () => {
      const row = await db.transaction((tx) => softDeleteDataRow(tx, rowId, actorUserId, { collabInternal: true }))
      if (row) notifyRowWrite({ tableId: row.tableId, rowIds: [row.id], kind: 'delete' })
      if (row?.status === 'published') bumpPublishVersion()
      return row
    }))
  }
  const localizations = await listContentLocalizations(db, { rowIds: [rowId] })
  const defaultLocale = await getDefaultLocale(db)
  const source = localizations.find((localization) => localization.localeId === defaultLocale.id)
  const { rows } = await db<{
    id: string
    table_id: string
    deleted_at: string | Date | null
  }>`
    update data_rows
    set deleted_at = current_timestamp,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id, table_id, deleted_at
  `
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    tableId: row.table_id,
    slug: source?.slug ?? '',
    status: localizations.some((localization) => localization.availability === 'online' && localization.activeVersionId)
      ? 'published' : source?.activeVersionId ? 'unpublished' : 'draft',
    deletedAt: isoDateOrNull(row.deleted_at),
  }
}

/**
 * Move a row to another table. Refuses if the target table is missing or
 * already has a non-deleted row with the same (non-empty) slug. Returns a
 * discriminated union so handlers can map each failure mode to the right HTTP
 * status.
 */
export async function updateDataRowTable(
  db: DbClient,
  rowId: string,
  tableId: string,
  actorUserId: string | null = null,
  opts: { collabInternal?: boolean; localeId?: string } = {},
): Promise<UpdateDataRowTableResult> {
  if (!opts.collabInternal) {
    // Lock order: collab write lane → publication → DB transaction. Publishers
    // flush collaboration before entering their publication critical section.
    return serializeCollabAwareWrite(() => withPublishLock(async () => {
      const before = await getDataRow(db, rowId, opts.localeId)
      const hadLiveVariant = (await listContentLocalizations(db, { rowIds: [rowId] })).some((variant) => variant.availability === 'online')
      const result = await db.transaction((tx) => updateDataRowTable(
        tx, rowId, tableId, actorUserId, { collabInternal: true, localeId: opts.localeId },
      ))
      if (before && result.ok && before.tableId !== result.row.tableId) {
        notifyRowWrite({ tableId: before.tableId, rowIds: [rowId], kind: 'delete' })
        notifyRowWrite({ tableId: result.row.tableId, rowIds: [rowId], kind: 'create' })
        if (hadLiveVariant) bumpPublishVersion()
      }
      return result
    }))
  }

  const row = await getDataRow(db, rowId, opts.localeId)
  if (!row) return { ok: false, reason: 'row_not_found' }
  if (row.tableId === tableId) return { ok: true, row }

  const targetTable = await getDataTable(db, tableId)
  const sourceTable = await getDataTable(db, row.tableId)
  if (!targetTable || !sourceTable) return { ok: false, reason: 'table_not_found' }
  if (targetTable.kind !== 'data' && targetTable.kind !== 'postType') {
    return { ok: false, reason: 'unsupported_table' }
  }

  const variants = await listContentLocalizations(db, { rowIds: [rowId] })
  for (const variant of variants) {
    if (!variant.slug) continue
    const { rows: conflictRows } = await db<{ id: string }>`
      select data_rows.id from data_rows
      join data_row_localizations localized on localized.row_id = data_rows.id
      where data_rows.table_id = ${tableId}
        and localized.locale_id = ${variant.localeId} and localized.slug = ${variant.slug}
        and data_rows.id <> ${rowId} and data_rows.deleted_at is null
      limit 1
    `
    if (conflictRows[0]) return { ok: false, reason: 'slug_conflict' }
  }

  await changeRowFieldLocalizationInTx(db, { id: row.id, cells_json: row.sharedCells }, sourceTable.fields, targetTable.fields, actorUserId)

  const { rows } = await db<{ id: string }>`
    update data_rows
    set table_id = ${tableId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return { ok: false, reason: 'row_not_found' }
  // A different collection changes route and template context for every language.
  await db`update data_row_localizations set availability = 'offline', scheduled_publish_at = null,
    scheduled_revision_json = null, seq = seq + 1, updated_at = current_timestamp, updated_by_user_id = ${actorUserId}
    where row_id = ${rowId}`
  const updated = await getDataRow(db, rows[0].id, opts.localeId)
  if (!updated) return { ok: false, reason: 'row_not_found' }
  return { ok: true, row: updated }
}

/**
 * Flip a row between `draft` and `unpublished` (the only states reachable
 * from this endpoint — `published` goes through the dedicated publish flow).
 * Retracts one language atomically with publication. Unpublished keeps its
 * historical version pointer; both states cancel the language schedule.
 */
export async function updateDataRowStatus(
  db: DbClient,
  rowId: string,
  status: 'draft' | 'unpublished',
  actorUserId: string | null = null,
  localeId?: string,
): Promise<DataRow | null> {
  return withPublishLock(async () => {
    const result = await db.transaction(async (tx) => {
      const locale = await resolveContentLocale(tx, localeId)
      const current = await getDataRow(tx, rowId, locale.id)
      if (!current) return null
      if (!current.localization) await saveContentLocalizationDraft(tx, rowId, locale.id, { cells: {}, slug: current.slug }, actorUserId)
      const updated = await setContentLocalizationAvailability(tx, rowId, locale.id, 'offline', actorUserId)
      if (!updated) return null
      // Both editor actions mean offline; historical publication remains in the version history.
      if (status === 'draft') {
        await tx`update data_row_localizations set active_version_id = null, published_at = null, published_by_user_id = null where row_id = ${rowId} and locale_id = ${locale.id}`
      }
      return getDataRow(tx, rowId, locale.id)
    })
    if (result) bumpPublishVersion()
    return result
  })
}

export async function updateDataRowAuthor(
  db: DbClient,
  rowId: string,
  authorUserId: string,
  actorUserId: string | null = null,
  localeId?: string,
): Promise<DataRow | null> {
  const locale = await resolveContentLocale(db, localeId)
  const { rows } = await db<{ id: string }>`
    update data_rows
    set author_user_id = ${authorUserId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id, locale.id) : null
}
