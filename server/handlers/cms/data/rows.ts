/**
 * Data-row endpoints.
 *
 *   GET    /admin/api/cms/data/authors                  — list assignable authors
 *   GET    /admin/api/cms/data/rows/:id                 — read a single row
 *   PATCH  /admin/api/cms/data/rows/:id                 — save the draft cells
 *   DELETE /admin/api/cms/data/rows/:id                 — soft delete
 *   POST   /admin/api/cms/data/rows/:id/publish         — publish
 *   PATCH  /admin/api/cms/data/rows/:id/status          — flip between draft/unpublished
 *   PATCH  /admin/api/cms/data/rows/:id/author          — reassign the author
 *   PATCH  /admin/api/cms/data/rows/:id/table           — move row to a new table
 *
 * `handleDataRowRoutes` runs a flat `DATA_ROW_ROUTES` table through the shared
 * `runRouteTable` dispatcher (`../routeTable.ts`); one handler below per
 * `(method, pattern)` owns its own body-parsing and audit emission.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import type { DataRow } from '@core/data/schemas'
import { createAuditEvent } from '../../../repositories/audit'
import {
  applyContentEntryCellsFilter,
  emitContentEntryDeleted,
  emitContentEntryUpdated,
} from '../../../publish/contentEvents'
import {
  cancelScheduledPublish,
  getDataRow,
  getDataTable,
  listDataAuthorOptions,
  publishDataRow,
  removeDataRowArtefact,
  saveDataRowDraft,
  scheduleDataRowPublish,
  softDeleteDataRow,
  updateDataRowAuthor,
  updateDataRowStatus,
  updateDataRowTable,
} from '../../../repositories/data'
import { findUserById } from '../../../repositories/users'
import { slugForTable } from '@core/data/cells'
import { badRequest, jsonResponse, readValidatedBody } from '../../../http'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import type { CmsHandlerOptions } from '../shared'
import { CMS_API_PREFIX, requestAuditContext } from '../shared'
import { runRouteTable, type Route, type RouteParams } from '../routeTable'
import {
  RowAuthorBodySchema,
  RowScheduleBodySchema,
  RowStatusBodySchema,
  RowTableBodySchema,
  RowUpsertBodySchema,
} from './schemas'
import {
  canEditDataRow,
  canPublishDataRow,
  canReadDataRow,
  forbidden,
  requireDataAccess,
  requireDataAuthorManager,
  requireDataEditor,
  requireDataPublisher,
  requireDataRowMover,
} from './access'
import { handleRowPreview } from './preview'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROW_NOT_FOUND_BODY = { error: 'Data row not found' }

function rowNotFound(): Response {
  return jsonResponse(ROW_NOT_FOUND_BODY, { status: 404 })
}

type DataRowAuditAction =
  | 'data.row.update'
  | 'data.row.delete'
  | 'data.row.status'
  | 'data.row.move'
  | 'data.row.publish'
  | 'data.row.schedule'
  | 'data.row.schedule.cancel'
  | 'data.author.assign'

async function recordRowAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: DataRowAuditAction,
  // Only the identity fields are logged, so both a hydrated `DataRow` and the
  // narrow `DeletedRowSummary` from a soft-delete satisfy this.
  row: Pick<DataRow, 'id' | 'tableId' | 'slug'>,
  extraMetadata?: Record<string, unknown>,
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'data_row',
    targetId: row.id,
    metadata: {
      tableId: row.tableId,
      slug: row.slug,
      ...extraMetadata,
    },
    ...requestAuditContext(req),
  })
}

/**
 * Load a row and run the caller's access check. Returns a Response on
 * 404 / forbidden so call sites can `if (row instanceof Response) return row`.
 */
async function loadRowForAccess(
  db: DbClient,
  rowId: string,
  user: AuthUser,
  check: (user: AuthUser, row: DataRow) => boolean,
): Promise<DataRow | Response> {
  const row = await getDataRow(db, rowId)
  if (!row) return rowNotFound()
  if (!check(user, row)) return forbidden()
  return row
}

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

async function handleListAuthors(req: Request, db: DbClient): Promise<Response> {
  const user = await requireDataAuthorManager(req, db)
  if (user instanceof Response) return user
  return jsonResponse({ authors: await listDataAuthorOptions(db) })
}

// GET reads (broader access); PATCH and DELETE mutate (editor-only) — the gate
// split that used to live inside one multi-method `handleRowItem` now rides the
// route table, one handler per method.
async function handleRowItemGet(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireDataAccess(req, db)
  if (user instanceof Response) return user

  const row = await loadRowForAccess(db, params.id, user, canReadDataRow)
  if (row instanceof Response) return row
  return jsonResponse({ row })
}

async function handleRowItemPatch(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataEditor(req, db)
  if (user instanceof Response) return user

  const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
  if (currentRow instanceof Response) return currentRow

  const body = await readValidatedBody(req, RowUpsertBodySchema)
  if (!body) return badRequest('Invalid row payload')

  const table = await getDataTable(db, currentRow.tableId)
  if (!table) return rowNotFound()

  const rawCells = body.cells ?? currentRow.cells
  // Run the `content.entry.cells` filter pipeline before persistence so
  // plugins can validate / normalize / auto-fill cells — the same shared
  // helper the plugin `cms.content.*` surface applies.
  const cells = await applyContentEntryCellsFilter(rawCells, {
    tableSlug: table.slug,
    entryId: rowId,
    actor: { kind: 'user', userId: user.id },
  })
  const slug = slugForTable(table, cells)

  const row = await saveDataRowDraft(db, rowId, { cells, slug }, user.id)
  if (!row) return rowNotFound()
  // Changed cell ids: the patch's own keys plus any keys the filter added
  // or rewrote. Plugins watch this list to loop-guard their own writes;
  // false positives are fine, false negatives are not.
  const patchedIds = body.cells ? Object.keys(body.cells) : []
  const filterChangedIds = Object.keys(cells).filter((k) => cells[k] !== rawCells[k])
  const changedFieldIds = [...new Set([...patchedIds, ...filterChangedIds])]
  await emitContentEntryUpdated(db, rowId, changedFieldIds, { kind: 'user', userId: user.id })
  await recordRowAuditEvent(db, user, req, 'data.row.update', row)
  return jsonResponse({ row })
}

async function handleRowItemDelete(
  req: Request,
  db: DbClient,
  params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataEditor(req, db)
  if (user instanceof Response) return user

  const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
  if (currentRow instanceof Response) return currentRow

  const row = await softDeleteDataRow(db, rowId, user.id)
  if (!row) return rowNotFound()
  // Prune the baked public artefact — a deleted row must stop being served
  // by Layer A, which reads the disk slot with no DB awareness (ISS-039).
  if (options.uploadsDir) {
    await removeDataRowArtefact(db, options.uploadsDir, rowId, row.slug).catch((err) => {
      console.error('[publish:row] failed to remove artefact for deleted row', rowId, err)
    })
  }
  // Layer B mirror of the artefact prune: a published row's route is
  // retracted, so the render cache must stop serving it.
  if (row.status === 'published') await bumpPublishVersionSerialized()
  await emitContentEntryDeleted(db, rowId, { kind: 'user', userId: user.id })
  await recordRowAuditEvent(db, user, req, 'data.row.delete', row)
  return jsonResponse({ row })
}

async function handleRowPublish(
  req: Request,
  db: DbClient,
  params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataPublisher(req, db)
  if (user instanceof Response) return user

  const currentRow = await loadRowForAccess(db, rowId, user, canPublishDataRow)
  if (currentRow instanceof Response) return currentRow

  const result = await publishDataRow(db, rowId, user.id, options.uploadsDir)
  await emitContentEntryUpdated(db, rowId, ['status'], { kind: 'user', userId: user.id })
  await recordRowAuditEvent(db, user, req, 'data.row.publish', result.row, {
    versionNumber: result.version.versionNumber,
  })
  return jsonResponse(result)
}

// Same RBAC as the publish endpoint — scheduling a publish is conceptually
// "publish later", not a new permission. POST sets/replaces the schedule;
// DELETE cancels a pending one. Each method re-runs the (idempotent) publisher
// gate + row load so the route table can address them as separate entries.
async function handleRowSchedulePost(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataPublisher(req, db)
  if (user instanceof Response) return user

  const currentRow = await loadRowForAccess(db, rowId, user, canPublishDataRow)
  if (currentRow instanceof Response) return currentRow

  const body = await readValidatedBody(req, RowScheduleBodySchema)
  if (!body) return badRequest('Body must be { at: ISO datetime }')

  const when = new Date(body.at)
  if (Number.isNaN(when.getTime())) {
    return badRequest('Invalid datetime — must be a parseable ISO 8601 string')
  }
  if (when.getTime() <= Date.now()) {
    return badRequest('Scheduled time must be in the future')
  }
  const whenIso = when.toISOString()

  const row = await scheduleDataRowPublish(db, rowId, whenIso, user.id)
  if (!row) return rowNotFound()
  await recordRowAuditEvent(db, user, req, 'data.row.schedule', row, {
    scheduledPublishAt: whenIso,
  })
  return jsonResponse({ row })
}

async function handleRowScheduleDelete(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataPublisher(req, db)
  if (user instanceof Response) return user

  const currentRow = await loadRowForAccess(db, rowId, user, canPublishDataRow)
  if (currentRow instanceof Response) return currentRow

  const row = await cancelScheduledPublish(db, rowId, user.id)
  if (!row) {
    // Either the row doesn't exist OR it wasn't scheduled. The repo
    // function gates on `status = 'scheduled'`, so a non-scheduled
    // row returns null. Surface a meaningful 404.
    return rowNotFound()
  }
  await recordRowAuditEvent(db, user, req, 'data.row.schedule.cancel', row)
  return jsonResponse({ row })
}

async function handleRowStatus(
  req: Request,
  db: DbClient,
  params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataEditor(req, db)
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, RowStatusBodySchema)
  if (!body) return badRequest('Status must be draft or unpublished')

  const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
  if (currentRow instanceof Response) return currentRow

  const row = await updateDataRowStatus(db, rowId, body.status, user.id)
  if (!row) return rowNotFound()
  // draft and unpublished both leave public visibility — prune the baked
  // artefact so Layer A stops serving the retracted content (ISS-039).
  if (options.uploadsDir) {
    await removeDataRowArtefact(db, options.uploadsDir, rowId, row.slug).catch((err) => {
      console.error('[publish:row] failed to remove artefact for retracted row', rowId, err)
    })
  }
  await recordRowAuditEvent(db, user, req, 'data.row.status', row, { status: body.status })
  return jsonResponse({ row })
}

async function handleRowAuthor(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const rowId = params.id
  const user = await requireDataAuthorManager(req, db)
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, RowAuthorBodySchema)
  if (!body || !body.authorUserId.trim()) return badRequest('Author is required')

  const author = await findUserById(db, body.authorUserId)
  if (!author || author.status !== 'active') return badRequest('Author must be an active user')

  const currentRow = await getDataRow(db, rowId)
  if (!currentRow) return rowNotFound()

  const row = await updateDataRowAuthor(db, rowId, body.authorUserId, user.id)
  if (!row) return rowNotFound()

  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'data.author.assign',
    targetType: 'data_row',
    targetId: row.id,
    metadata: {
      previousAuthorUserId: currentRow.authorUserId,
      authorUserId: body.authorUserId,
    },
    ...requestAuditContext(req),
  })
  return jsonResponse({ row })
}

async function handleRowTable(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const rowId = params.id
  // Cross-collection move = structurally distinct from cell-level editing.
  // A junior editor with `content.edit.any` should not be able to take a
  // post out of Posts and into Drafts (breaks the URL — different route
  // base). Split out as `data.rows.move` so the operator can grant it
  // separately. See G2 / B8 in the capabilities review.
  const user = await requireDataRowMover(req, db)
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, RowTableBodySchema)
  if (!body || !body.tableId.trim()) return badRequest('Table is required')

  const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
  if (currentRow instanceof Response) return currentRow

  const result = await updateDataRowTable(db, rowId, body.tableId, user.id)
  if (result.ok) {
    await recordRowAuditEvent(db, user, req, 'data.row.move', result.row)
    return jsonResponse({ row: result.row })
  }
  if (result.reason === 'slug_conflict') {
    return jsonResponse(
      { error: 'A row with this slug already exists in the target table' },
      { status: 409 },
    )
  }
  if (result.reason === 'table_not_found') {
    return jsonResponse({ error: 'Table not found' }, { status: 404 })
  }
  return rowNotFound()
}

// ---------------------------------------------------------------------------
// Route table + dispatcher
// ---------------------------------------------------------------------------

// `(?<id>[^/]+)` cannot span a `/`, and every parameterised pattern is anchored
// with `$`, so the sub-routes (`/publish`, `/schedule`, …) are mutually
// exclusive with the bare `/rows/:id` item route — order is not load-bearing
// for correctness. They are still declared specific-first to mirror the
// original dispatcher and read top-down.
const ROW_ITEM = `${CMS_API_PREFIX}/data/rows/(?<id>[^/]+)`

const DATA_ROW_ROUTES: readonly Route<[CmsHandlerOptions]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/data/authors`, handler: handleListAuthors },
  { method: 'POST', pattern: new RegExp(`^${ROW_ITEM}/publish$`), handler: handleRowPublish },
  { method: 'POST', pattern: new RegExp(`^${ROW_ITEM}/schedule$`), handler: handleRowSchedulePost },
  { method: 'DELETE', pattern: new RegExp(`^${ROW_ITEM}/schedule$`), handler: handleRowScheduleDelete },
  { method: 'PATCH', pattern: new RegExp(`^${ROW_ITEM}/status$`), handler: handleRowStatus },
  { method: 'PATCH', pattern: new RegExp(`^${ROW_ITEM}/author$`), handler: handleRowAuthor },
  { method: 'PATCH', pattern: new RegExp(`^${ROW_ITEM}/table$`), handler: handleRowTable },
  { method: 'POST', pattern: new RegExp(`^${ROW_ITEM}/preview$`), handler: handleRowPreview },
  { method: 'GET', pattern: new RegExp(`^${ROW_ITEM}$`), handler: handleRowItemGet },
  { method: 'PATCH', pattern: new RegExp(`^${ROW_ITEM}$`), handler: handleRowItemPatch },
  { method: 'DELETE', pattern: new RegExp(`^${ROW_ITEM}$`), handler: handleRowItemDelete },
]

export async function handleDataRowRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  return runRouteTable(req, db, DATA_ROW_ROUTES, options)
}
