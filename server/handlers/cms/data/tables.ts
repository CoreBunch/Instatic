/**
 * Data-table endpoints.
 *
 *   GET    /admin/api/cms/data/tables              — list tables
 *   POST   /admin/api/cms/data/tables              — create a table (`content.manage`)
 *   GET    /admin/api/cms/data/tables/:id          — read one table (any data access)
 *   PATCH  /admin/api/cms/data/tables/:id          — partial update (`content.manage`)
 *   DELETE /admin/api/cms/data/tables/:id          — soft delete (`content.manage`)
 *
 *   GET    /admin/api/cms/data/tables/:id/rows          — list rows in a table
 *   POST   /admin/api/cms/data/tables/:id/rows          — create a draft row
 *   GET    /admin/api/cms/data/tables/:id/loop-preview  — published rows as LoopItems (editor canvas)
 *
 * The `/tables/:id/rows` and `/loop-preview` routes live here (not in rows.ts)
 * because the URL is rooted under `/tables/...` and the handlers reuse the
 * table-fetch context. `rows.ts` owns every other row-keyed URL.
 *
 * `handleDataTableRoutes` is the dispatcher; one function below per URL
 * pattern owns its own method-routing, body-parsing, and audit emission.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import type { DataTable } from '@core/data/schemas'
import { createAuditEvent } from '../../../repositories/audit'
import {
  applyContentEntryCellsFilter,
  emitContentEntryCreated,
} from '../../../publish/contentEvents'
import {
  createDataTable,
  getDataTable,
  listDataTablesWithCounts,
  softDeleteDataTable,
  updateDataTable,
  createDataRow,
  listDataRows,
} from '../../../repositories/data'
import { ensureDefaultEntryTemplate } from '../../../publish/templateSeeding'
import { normalizeDataTableFields } from '@core/data/fields'
import { slugForTable } from '@core/data/cells'
import { slugFromTitle } from '@core/utils/slug'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { CMS_API_PREFIX, requestAuditContext } from '../shared'
import {
  TableCreateBodySchema,
  TablePatchBodySchema,
  RowUpsertBodySchema,
  type TablePatchBody,
} from './schemas'
import {
  canSeeAllDataRows,
  requireDataAccess,
  requireDataCreator,
  requireDataTablesManager,
  requireDataTablesRead,
} from './access'
import { requireStepUp } from '../../../auth/authz'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTablePatch(
  body: TablePatchBody,
  actorUserId: string,
): Parameters<typeof updateDataTable>[2] | { error: string } {
  const update: Parameters<typeof updateDataTable>[2] = {}

  if (body.name !== undefined) {
    if (!body.name.trim()) return { error: 'Table name is required' }
    update.name = body.name.trim()
  }
  if (body.slug !== undefined) {
    const slug = slugFromTitle(body.slug.trim())
    if (!slug) return { error: 'Table slug is required' }
    update.slug = slug
  }
  if (body.routeBase !== undefined) {
    update.routeBase = normalizeRouteBase(body.routeBase.trim())
  }
  if (body.singularLabel !== undefined) {
    if (!body.singularLabel.trim()) return { error: 'Singular label is required' }
    update.singularLabel = body.singularLabel.trim()
  }
  if (body.pluralLabel !== undefined) {
    if (!body.pluralLabel.trim()) return { error: 'Plural label is required' }
    update.pluralLabel = body.pluralLabel.trim()
  }
  if (body.primaryFieldId !== undefined) {
    if (!body.primaryFieldId.trim()) return { error: 'Primary field id is required' }
    update.primaryFieldId = body.primaryFieldId.trim()
  }
  if (body.fields !== undefined) {
    update.fields = normalizeDataTableFields(body.fields)
  }

  if (Object.keys(update).length === 0) return { error: 'Table update is required' }
  update.updatedByUserId = actorUserId
  return update
}

type TableAuditAction =
  | 'data.table.create'
  | 'data.table.update'
  | 'data.table.delete'

async function recordTableAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: TableAuditAction,
  table: DataTable,
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'data_table',
    targetId: table.id,
    metadata: { slug: table.slug },
    ...requestAuditContext(req),
  })
}

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

/**
 * The tables list endpoint is read by two distinct audiences:
 *   - Data workspace UI — gated by `data.tables.read` (schema browser).
 *   - Loop / template pickers in the site editor — gated by any `content.*`
 *     access cap because the picker only needs to know what tables exist
 *     to choose a loop source.
 *
 * Either cap family is sufficient — the response is the same list of
 * tables + counts. Mutations stay strict (`data.tables.manage`).
 */
async function requireAnyRead(req: Request, db: DbClient): Promise<AuthUser | Response> {
  const tablesRead = await requireDataTablesRead(req, db)
  if (!(tablesRead instanceof Response)) return tablesRead
  return requireDataAccess(req, db)
}

async function handleTablesCollection(req: Request, db: DbClient): Promise<Response> {
  // GET = schema-level read (`data.tables.read` — Data workspace floor;
  // `content.*` callers also accepted because the loop picker calls this
  // and they need to know what tables exist).
  // POST = schema mutation (`data.tables.manage` + step-up — creating a
  // table changes the public route surface of the site).
  const user = req.method === 'GET'
    ? await requireAnyRead(req, db)
    : await requireDataTablesManager(req, db)
  if (user instanceof Response) return user

  if (req.method === 'POST') {
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }

  if (req.method === 'GET') {
    const url = new URL(req.url)
    const query = url.searchParams.get('query')?.trim().toLowerCase() ?? ''
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 25, 1), 100) : null

    let tables = await listDataTablesWithCounts(db)

    if (query) {
      tables = tables.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.slug.toLowerCase().includes(query),
      )
    }

    if (limit !== null) {
      tables = tables.slice(0, limit)
    }

    return jsonResponse({ tables })
  }

  if (req.method === 'POST') {
    const body = await readValidatedBody(req, TableCreateBodySchema)
    if (!body) return badRequest('Invalid table payload')

    const name = body.name.trim()
    if (!name) return badRequest('Table name is required')

    const singularLabel = body.singularLabel?.trim() || name.replace(/s$/i, '') || name
    const pluralLabel = body.pluralLabel?.trim() || name
    const slug = slugFromTitle(body.slug?.trim() || pluralLabel)
    const routeBase = normalizeRouteBase(body.routeBase?.trim() || slug)

    const table = await createDataTable(db, {
      name,
      slug,
      kind: body.kind === 'postType' ? 'postType' : 'data',
      routeBase,
      singularLabel,
      pluralLabel,
      primaryFieldId: body.primaryFieldId?.trim() || undefined,
      fields: normalizeDataTableFields(body.fields),
      createdByUserId: user.id,
      updatedByUserId: user.id,
    })
    // postType tables need a default entry template so the public route
    // `/<route-base>/<row-slug>` resolves immediately (no-op for `data` kind).
    await ensureDefaultEntryTemplate(db, table, user.id)
    await recordTableAuditEvent(db, user, req, 'data.table.create', table)
    return jsonResponse({ table }, { status: 201 })
  }

  return methodNotAllowed()
}

async function handleTableItem(
  req: Request,
  db: DbClient,
  tableId: string,
): Promise<Response> {
  // GET = schema read (Data workspace OR loop pickers in site editor).
  if (req.method === 'GET') {
    const user = await requireAnyRead(req, db)
    if (user instanceof Response) return user
    const table = await getDataTable(db, tableId)
    if (!table) return jsonResponse({ error: 'Table not found' }, { status: 404 })
    return jsonResponse({ table })
  }

  // PATCH/DELETE = schema mutation. Step-up gated — renaming or deleting a
  // table changes / breaks every public URL under its route base.
  const user = await requireDataTablesManager(req, db)
  if (user instanceof Response) return user
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

  if (req.method === 'PATCH') {
    const body = await readValidatedBody(req, TablePatchBodySchema)
    if (!body) return badRequest('Invalid table payload')

    const update = buildTablePatch(body, user.id)
    if ('error' in update) return badRequest(update.error)

    const table = await updateDataTable(db, tableId, update)
    if (!table) return jsonResponse({ error: 'Table not found' }, { status: 404 })
    await recordTableAuditEvent(db, user, req, 'data.table.update', table)
    return jsonResponse({ table })
  }

  if (req.method === 'DELETE') {
    const table = await softDeleteDataTable(db, tableId, user.id)
    if (!table) return jsonResponse({ error: 'Table cannot be deleted' }, { status: 409 })
    await recordTableAuditEvent(db, user, req, 'data.table.delete', table)
    return jsonResponse({ table })
  }

  return methodNotAllowed()
}

async function handleTableRows(
  req: Request,
  db: DbClient,
  tableId: string,
): Promise<Response> {
  const user = req.method === 'POST'
    ? await requireDataCreator(req, db)
    : await requireDataAccess(req, db)
  if (user instanceof Response) return user

  const table = await getDataTable(db, tableId)
  if (!table) return jsonResponse({ error: 'Table not found' }, { status: 404 })

  if (req.method === 'GET') {
    const visibility = canSeeAllDataRows(user) ? {} : { ownerUserId: user.id }
    return jsonResponse({ rows: await listDataRows(db, tableId, visibility) })
  }

  if (req.method === 'POST') {
    const body = await readValidatedBody(req, RowUpsertBodySchema)
    if (!body) return badRequest('Invalid row payload')

    // Run the `content.entry.cells` filter pipeline before persistence so
    // plugins can validate / normalize / auto-fill cells — the same shared
    // helper the plugin `cms.content.*` surface applies.
    const cells = await applyContentEntryCellsFilter(body.cells ?? {}, {
      tableSlug: table.slug,
      entryId: 'new',
      actor: { kind: 'user', userId: user.id },
    })
    const slug = slugForTable(table, cells)

    const row = await createDataRow(db, { tableId, cells, slug }, user.id)
    await emitContentEntryCreated(db, row.id, { kind: 'user', userId: user.id })
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'data.row.create',
      targetType: 'data_row',
      targetId: row.id,
      metadata: { tableId, slug: row.slug },
      ...requestAuditContext(req),
    })
    return jsonResponse({ row }, { status: 201 })
  }

  return methodNotAllowed()
}

// Editor canvas preview: real published rows projected as LoopItems via the
// same code path the publisher uses (`fetchPublishedDataRowItems`). The
// canvas hook `useLoopPreviewItems` falls back to synthetic preview items
// when this returns an empty list, so the loop body stays visible even when
// no rows are published yet.
async function handleTableLoopPreview(
  req: Request,
  db: DbClient,
  tableId: string,
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireDataAccess(req, db)
  if (user instanceof Response) return user

  const table = await getDataTable(db, tableId)
  if (!table) return jsonResponse({ error: 'Table not found' }, { status: 404 })

  const url = new URL(req.url)
  const orderBy = url.searchParams.get('orderBy') ?? 'publishedAt'
  const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc'
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '6', 10)
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 6, 1), 50)
  const rawOffset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10)
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0)

  const result = await fetchPublishedDataRowItems(db, {
    tableId,
    orderBy,
    direction,
    limit,
    offset,
  })
  return jsonResponse(result)
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const TABLE_ITEM_PATTERN = /^\/admin\/api\/cms\/data\/tables\/([^/]+)$/
const TABLE_ROWS_PATTERN = /^\/admin\/api\/cms\/data\/tables\/([^/]+)\/rows$/
const TABLE_LOOP_PREVIEW_PATTERN = /^\/admin\/api\/cms\/data\/tables\/([^/]+)\/loop-preview$/

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleDataTableRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  if (pathname === `${CMS_API_PREFIX}/data/tables`) {
    return handleTablesCollection(req, db)
  }

  // Sub-routes must match before the bare `/tables/:id` so that pattern
  // doesn't swallow `:id/rows` or `:id/loop-preview` (regex `[^/]+`
  // matches the whole tail).
  const loopPreviewMatch = pathname.match(TABLE_LOOP_PREVIEW_PATTERN)
  if (loopPreviewMatch) {
    return handleTableLoopPreview(req, db, decodeURIComponent(loopPreviewMatch[1]))
  }

  const rowsMatch = pathname.match(TABLE_ROWS_PATTERN)
  if (rowsMatch) {
    return handleTableRows(req, db, decodeURIComponent(rowsMatch[1]))
  }

  const itemMatch = pathname.match(TABLE_ITEM_PATTERN)
  if (itemMatch) {
    return handleTableItem(req, db, decodeURIComponent(itemMatch[1]))
  }

  return null
}
