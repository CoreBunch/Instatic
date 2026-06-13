import { Type } from '@sinclair/typebox'
import type {
  DataTable,
  DataTableListItem,
  DataRow,
  DataUserReference,
  CreateDataTableInput,
  UpdateDataTableInput,
  CreateDataRowInput,
  SaveDataRowDraftInput,
  DataMeta,
} from '@core/data/schemas'
import type { DeletedRowSummary } from '@core/data/schemas'
import {
  DataMetaSchema,
  DataRowSchema,
  DataTableListItemSchema,
  DataTableSchema,
  DataUserReferenceSchema,
  DeletedRowSummarySchema,
} from '@core/data/schemas'
import type { LoopItem } from '@core/loops/types'
import { LoopItemSchema } from '@core/loops/types'
import { apiRequest, assertOk, ApiError, type FetchLike } from '@core/http'

// ---------------------------------------------------------------------------
// Envelope schemas
// ---------------------------------------------------------------------------

const TablesListEnvelope = Type.Object(
  { tables: Type.Optional(Type.Array(DataTableListItemSchema)) },
  { additionalProperties: true },
)

const RowsListEnvelope = Type.Object(
  { rows: Type.Optional(Type.Array(DataRowSchema)) },
  { additionalProperties: true },
)

const AuthorsListEnvelope = Type.Object(
  { authors: Type.Optional(Type.Array(DataUserReferenceSchema)) },
  { additionalProperties: true },
)

const TableEnvelope = Type.Object(
  { table: Type.Optional(DataTableSchema) },
  { additionalProperties: true },
)

const RowEnvelope = Type.Object(
  { row: Type.Optional(DataRowSchema) },
  { additionalProperties: true },
)

const DeletedRowEnvelope = Type.Object(
  { row: Type.Optional(DeletedRowSummarySchema) },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// Data table CRUD
// ---------------------------------------------------------------------------

export async function listCmsDataTables(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTableListItem[]> {
  const body = await apiRequest(`${basePath}/data/tables`, {
    schema: TablesListEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data tables request failed',
  })
  return body.tables ?? []
}

export async function getCmsDataTable(
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable | null> {
  try {
    const body = await apiRequest(`${basePath}/data/tables/${encodeURIComponent(tableId)}`, {
      schema: TableEnvelope,
      fetchImpl,
      fallbackMessage: 'CMS data table fetch failed',
    })
    return body.table ?? null
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function getCmsDataTableBySlug(
  slug: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable | null> {
  const tables = await listCmsDataTables(fetchImpl, basePath)
  return tables.find((t) => t.slug === slug) ?? null
}

export async function createCmsDataTable(
  input: CreateDataTableInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable> {
  const body = await apiRequest(`${basePath}/data/tables`, {
    method: 'POST',
    body: input,
    schema: TableEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data table create failed',
  })
  if (!body.table) throw new Error('CMS data table create response was missing table')
  return body.table
}

export async function updateCmsDataTable(
  tableId: string,
  input: UpdateDataTableInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable> {
  const body = await apiRequest(`${basePath}/data/tables/${encodeURIComponent(tableId)}`, {
    method: 'PATCH',
    body: input,
    schema: TableEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data table update failed',
  })
  if (!body.table) throw new Error('CMS data table update response was missing table')
  return body.table
}

export async function deleteCmsDataTable(
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable> {
  const body = await apiRequest(`${basePath}/data/tables/${encodeURIComponent(tableId)}`, {
    method: 'DELETE',
    schema: TableEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data table delete failed',
  })
  if (!body.table) throw new Error('CMS data table delete response was missing table')
  return body.table
}

// ---------------------------------------------------------------------------
// Data row CRUD
// ---------------------------------------------------------------------------

export async function listCmsDataRows(
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow[]> {
  const body = await apiRequest(
    `${basePath}/data/tables/${encodeURIComponent(tableId)}/rows`,
    { schema: RowsListEnvelope, fetchImpl, fallbackMessage: 'CMS data rows request failed' },
  )
  return body.rows ?? []
}

export async function createCmsDataRow(
  tableId: string,
  input: CreateDataRowInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(
    `${basePath}/data/tables/${encodeURIComponent(tableId)}/rows`,
    { method: 'POST', body: input, schema: RowEnvelope, fetchImpl, fallbackMessage: 'CMS data row create failed' },
  )
  if (!body.row) throw new Error('CMS data row create response was missing row')
  return body.row
}

export async function saveCmsDataRowDraft(
  rowId: string,
  input: SaveDataRowDraftInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    body: input,
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row save failed',
  })
  if (!body.row) throw new Error('CMS data row save response was missing row')
  return body.row
}

export async function deleteCmsDataRow(
  rowId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DeletedRowSummary> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}`, {
    method: 'DELETE',
    schema: DeletedRowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row delete failed',
  })
  if (!body.row) throw new Error('CMS data row delete response was missing row')
  return body.row
}

export async function publishCmsDataRow(
  rowId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}/publish`, {
    method: 'POST',
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row publish failed',
  })
  if (!body.row) throw new Error('CMS data row publish response was missing row')
  return body.row
}

/**
 * Schedule a row's publication for a future ISO datetime. The
 * server-side publish-scheduler tick (`server/publish/publishScheduler.ts`)
 * picks the row up once `at <= now()` and calls the regular publish
 * flow. The server validates that `at` is in the future and rejects
 * past timestamps with a 400.
 */
export async function scheduleCmsDataRowPublish(
  rowId: string,
  atIso: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}/schedule`, {
    method: 'POST',
    body: { at: atIso },
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row schedule failed',
  })
  if (!body.row) throw new Error('CMS data row schedule response was missing row')
  return body.row
}

/**
 * Cancel a pending scheduled publication. Reverts the row to `'draft'`
 * status and clears `scheduledPublishAt`. Returns 404 if the row isn't
 * currently scheduled (or doesn't exist).
 */
export async function cancelCmsDataRowSchedule(
  rowId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}/schedule`, {
    method: 'DELETE',
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row schedule cancel failed',
  })
  if (!body.row) throw new Error('CMS data row schedule cancel response was missing row')
  return body.row
}

export async function updateCmsDataRowStatus(
  rowId: string,
  // Mirrors the server handler's accepted statuses
  // (`server/handlers/cms/data/rows.ts` → `handleRowStatus`). The status
  // endpoint is the bare draft↔unpublished toggle. Publishing goes
  // through `publishCmsDataRow`; scheduling goes through
  // `scheduleCmsDataRowPublish`. The client signature is narrow so the
  // type system enforces "use the right endpoint" at the call site.
  status: 'draft' | 'unpublished',
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}/status`, {
    method: 'PATCH',
    body: { status },
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row status update failed',
  })
  if (!body.row) throw new Error('CMS data row status response was missing row')
  return body.row
}

export async function updateCmsDataRowAuthor(
  rowId: string,
  authorUserId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}/author`, {
    method: 'PATCH',
    body: { authorUserId },
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row author update failed',
  })
  if (!body.row) throw new Error('CMS data row author response was missing row')
  return body.row
}

export async function updateCmsDataRowTable(
  rowId: string,
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const body = await apiRequest(`${basePath}/data/rows/${encodeURIComponent(rowId)}/table`, {
    method: 'PATCH',
    body: { tableId },
    schema: RowEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data row table update failed',
  })
  if (!body.row) throw new Error('CMS data row table response was missing row')
  return body.row
}

// ---------------------------------------------------------------------------
// Loop preview — real published rows projected as LoopItems
//
// Used by the editor canvas `useLoopPreviewItems` hook for `data.rows`
// loops so the preview matches what the publisher will emit. Falls back
// to synthetic placeholder items only when the table has no published rows.
// ---------------------------------------------------------------------------

const LoopPreviewEnvelope = Type.Object(
  {
    items: Type.Optional(Type.Array(LoopItemSchema)),
    totalItems: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

interface DataLoopPreviewOptions {
  orderBy?: string
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

interface DataLoopPreviewResult {
  items: LoopItem[]
  totalItems: number
}

export async function previewCmsDataLoopItems(
  tableId: string,
  options: DataLoopPreviewOptions = {},
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataLoopPreviewResult> {
  const body = await apiRequest(
    `${basePath}/data/tables/${encodeURIComponent(tableId)}/loop-preview`,
    {
      query: {
        orderBy: options.orderBy,
        direction: options.direction,
        limit: options.limit,
        offset: options.offset,
      },
      schema: LoopPreviewEnvelope,
      fetchImpl,
      fallbackMessage: 'CMS data loop preview failed',
    },
  )
  return {
    items: body.items ?? [],
    totalItems: body.totalItems ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Live-mode preview — renders an entry through the real publish pipeline
// using the draft cells from the editor's in-memory state. The response
// is the full HTML document (sandboxed in an iframe on the client side)
// rather than JSON, so we perform the fetch directly and return text after
// asserting the response is OK.
// ---------------------------------------------------------------------------

interface PreviewCmsDataRowOptions {
  /** Draft cells to merge over the row's persisted state. */
  cells?: Record<string, unknown>
  /** Abort signal so the caller can cancel a stale request. */
  signal?: AbortSignal
  fetchImpl?: FetchLike
  basePath?: string
}

export async function previewCmsDataRow(
  rowId: string,
  options: PreviewCmsDataRowOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const basePath = options.basePath ?? '/admin/api/cms'
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cells: options.cells ?? {} }),
    signal: options.signal,
  })
  // The preview endpoint returns an HTML document on success; assertOk reads the
  // standard `{ error }` envelope (then raw text, then fallback) on failure.
  await assertOk(res, `CMS data row preview failed with ${res.status}`)
  return await res.text()
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export async function listCmsDataAuthors(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataUserReference[]> {
  const body = await apiRequest(`${basePath}/data/authors`, {
    schema: AuthorsListEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data authors request failed',
  })
  return body.authors ?? []
}

// ---------------------------------------------------------------------------
// Data meta
// ---------------------------------------------------------------------------

const DataMetaEnvelope = Type.Object(
  { meta: DataMetaSchema },
  { additionalProperties: true },
)

export async function getDataMeta(
  options?: { fetchImpl?: FetchLike; basePath?: string },
): Promise<DataMeta> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const basePath = options?.basePath ?? '/admin/api/cms'
  const body = await apiRequest(`${basePath}/data/_meta`, {
    schema: DataMetaEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS data meta request failed',
  })
  return body.meta
}

