/**
 * Content-scope read tools — server-resolved.
 *
 * Seven read tools that hit the data + media + user repositories directly
 * through `ctx.db`. None of them mutate; all results are shape-projected to
 * compact "agent-friendly" rows so we don't blow up the context window with
 * fields the model doesn't need (user join columns, internal timestamps,
 * deleted-at sentinels, etc.).
 *
 * Body fields are exchanged as plain strings — the bridge converts to/from
 * Tiptap on the browser side. The tools here don't touch the body shape.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool } from '../types'
import type { ToolContext } from '../../runtime/types'
import {
  getDataRow,
  listDataAuthorOptions,
  listDataRows,
  listDataTablesWithCounts,
  readDataLocalization,
} from '../../../repositories/data'
import { canReadDataRow, canReadTable, canSeeAllDataRows, type DataAccessUser } from '../../../auth/dataAccess'
import { listMediaAssets } from '../../../repositories/media'
import { readDisplayTitle, dataCellTextValues } from '@core/data/cells'
import { hasLocalizedDataFields, projectLocalizedDataCells, type DataLocalizationContext } from '@core/data/localizedCells'
import { normalizeDataTableFields } from '@core/data/fields'
import type { DataField, DataLocalization, DataRow, DataTableListItem } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — each tool mirrors its HTTP-route gate.
// ---------------------------------------------------------------------------

// Document (data-row) content read — mirrors `requireDataAccess`
// (DATA_ACCESS_CAPABILITIES in server/auth/dataAccess.ts).
const DOCUMENT_READ_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

// Schema-level read — mirrors `requireDataTablesRead`. Covers both table
// families since these tools read custom-data and component (system) schemas.
const SCHEMA_READ_CAPS: readonly CoreCapability[] = [
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
]

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

/**
 * Decide which kinds of collections are visible to the Content workspace.
 * Pages, reusable data, components, and layouts belong to the Site/Data
 * workspaces and cannot be activated by the Content browser bridge. Keeping
 * this catalog aligned with the actual writable surface avoids advertising a
 * collection that every subsequent focus/write tool must reject.
 */
const CONTENT_KIND_VISIBLE: ReadonlySet<string> = new Set(['postType'])

function projectCollection(table: DataTableListItem) {
  return {
    id: table.id,
    slug: table.slug,
    label: table.pluralLabel || table.name,
    kind: table.kind,
    rowCount: table.rowCount,
    primaryFieldId: table.primaryFieldId,
  }
}

function projectField(field: DataField): Record<string, unknown> {
  // Discriminated union — pick the keys an agent actually consumes.
  const base = {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required ?? false,
    builtIn: field.builtIn ?? false,
  }
  if (field.type === 'select' || field.type === 'multiSelect') {
    return { ...base, options: field.options.map((o) => ({ value: o.id, label: o.label })) }
  }
  if (field.type === 'media') {
    return {
      ...base,
      mediaKind: field.mediaKind,
      allowMultiple: field.allowMultiple ?? false,
    }
  }
  if (field.type === 'relation') {
    return {
      ...base,
      targetTableId: field.targetTableId,
      allowMultiple: field.allowMultiple ?? false,
    }
  }
  if (field.type === 'localizedText') return { ...base, writeShape: '{ key: string }' }
  if (field.type === 'repeater') return { ...base, fields: field.fields.map(projectField) }
  return base
}

function dataToolUser(ctx: ToolContext): DataAccessUser {
  return { id: ctx.userId, capabilities: [...ctx.capabilities] }
}

function visibleContentTables(tables: DataTableListItem[], user: DataAccessUser): DataTableListItem[] {
  return tables.filter(table => CONTENT_KIND_VISIBLE.has(table.kind) && canReadTable(user, table))
}

async function localizationFor(ctx: ToolContext, tables: DataTableListItem[], language?: string): Promise<DataLocalization | undefined> {
  const localized = tables.filter(table => hasLocalizedDataFields(table.fields))
  return localized.length > 0 ? readDataLocalization(ctx.db, ctx.branch, dataToolUser(ctx), localized, language) : undefined
}

function languageContext(localization: DataLocalization | undefined): DataLocalizationContext | undefined {
  return localization?.language && localization.translations
    ? { language: localization.language, translations: localization.translations }
    : undefined
}

function projectRow(row: DataRow, table: DataTableListItem, localization?: DataLocalizationContext) {
  const needsLanguage = hasLocalizedDataFields(table.fields) && !localization
  return {
    id: row.id,
    tableId: row.tableId,
    ...(!needsLanguage ? { title: readDisplayTitle(row.cells, table, localization) } : {}),
    slug: row.slug,
    status: row.status,
    authorUserId: row.authorUserId,
    updatedAt: row.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// content_list_collections
// ---------------------------------------------------------------------------

const LanguageInput = Type.Optional(Type.String({ minLength: 1, description: 'Explicit configured content language. Localized collections return metadata only until chosen.' }))
const ListCollectionsInput = Type.Object({ language: LanguageInput })

const listCollectionsTool: AiTool = {
  name: 'content_list_collections',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: SCHEMA_READ_CAPS,
  description:
    'List every Content-workspace collection (routable post types only) with id, slug, label, kind, row count, and primary field id. Pages are edited through Site tools; reusable tables through Data tools.',
  inputSchema: ListCollectionsInput,
  handler: async (input, ctx) => {
    const { language } = input as Static<typeof ListCollectionsInput>
    const tables = visibleContentTables(await listDataTablesWithCounts(ctx.db, ctx.branch), dataToolUser(ctx))
    return {
      collections: tables.map(projectCollection),
      localization: await localizationFor(ctx, tables, language),
    }
  },
}

// ---------------------------------------------------------------------------
// content_get_collection_schema
// ---------------------------------------------------------------------------

const GetCollectionSchemaInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  language: LanguageInput,
})

const getCollectionSchemaTool: AiTool = {
  name: 'content_get_collection_schema',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: SCHEMA_READ_CAPS,
  description:
    "Return one collection's field schema: each field's id, label, type, required flag, builtIn flag, and per-type extras (select options, media kind, relation target). Call BEFORE content_set_document_field on an unfamiliar collection so you know the field's value shape.",
  inputSchema: GetCollectionSchemaInput,
  handler: async (input, ctx) => {
    const { tableId, language } = input as Static<typeof GetCollectionSchemaInput>
    const tables = visibleContentTables(await listDataTablesWithCounts(ctx.db, ctx.branch), dataToolUser(ctx))
    const table = tables.find((t) => t.id === tableId)
    if (!table) {
      return { ok: false, error: `Collection ${tableId} not found.` }
    }
    const fields = normalizeDataTableFields(table.fields)
    return {
      collection: {
        ...projectCollection(table),
        fields: fields.map(projectField),
      },
      localization: await localizationFor(ctx, [table], language),
    }
  },
}

// ---------------------------------------------------------------------------
// content_list_documents
// ---------------------------------------------------------------------------

const ListDocumentsInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  language: LanguageInput,
  status: Type.Optional(Type.Union([
    Type.Literal('draft'),
    Type.Literal('unpublished'),
    Type.Literal('published'),
    Type.Literal('scheduled'),
  ])),
  authorUserId: Type.Optional(Type.String({ minLength: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
})

const listDocumentsTool: AiTool = {
  name: 'content_list_documents',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_READ_CAPS,
  description:
    'List documents in one collection. Returns id, title, slug, status, authorUserId, updatedAt — light projection. Filter by status / authorUserId, paginate with limit (default 25, max 200) + offset.',
  inputSchema: ListDocumentsInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ListDocumentsInput>
    const user = dataToolUser(ctx)
    const tables = visibleContentTables(await listDataTablesWithCounts(ctx.db, ctx.branch), user)
    const table = tables.find(candidate => candidate.id === args.tableId)
    if (!table) return { ok: false, error: `Collection ${args.tableId} not found.` }
    const localization = await localizationFor(ctx, [table], args.language)
    const context = languageContext(localization)
    const all = await listDataRows(ctx.db, ctx.branch, args.tableId, canSeeAllDataRows(user) ? {} : { ownerUserId: user.id })
    let filtered = all.filter(row => canReadDataRow(user, row))
    if (args.status) filtered = filtered.filter((r) => r.status === args.status)
    if (args.authorUserId) filtered = filtered.filter((r) => r.authorUserId === args.authorUserId)
    const offset = args.offset ?? 0
    const limit = args.limit ?? 25
    const slice = filtered.slice(offset, offset + limit)
    return {
      total: filtered.length,
      offset,
      limit,
      documents: slice.map(row => projectRow(row, table, context)),
      localization,
    }
  },
}

// ---------------------------------------------------------------------------
// content_get_document
// ---------------------------------------------------------------------------

const GetDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
  language: LanguageInput,
})

const getDocumentTool: AiTool = {
  name: 'content_get_document',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_READ_CAPS,
  description:
    "Return one document's full state: every field value (body is a markdown string), status, author, slug, timestamps. Use for the doc the user wants to edit when it isn't the active doc, or to refresh state after another agent action.",
  inputSchema: GetDocumentInput,
  handler: async (input, ctx) => {
    const { documentId, language } = input as Static<typeof GetDocumentInput>
    const user = dataToolUser(ctx)
    const row = await getDataRow(ctx.db, ctx.branch, documentId)
    const tables = visibleContentTables(await listDataTablesWithCounts(ctx.db, ctx.branch), user)
    const table = row && tables.find(candidate => candidate.id === row.tableId)
    if (!row || !table || !canReadDataRow(user, row)) {
      return { ok: false, error: `Document ${documentId} not found.` }
    }
    const localization = await localizationFor(ctx, [table], language)
    const context = languageContext(localization)
    const needsLanguage = hasLocalizedDataFields(table.fields) && !context
    return {
      document: {
        ...projectRow(row, table, context),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        publishedAt: row.publishedAt,
        scheduledPublishAt: row.scheduledPublishAt,
        ...(!needsLanguage ? { fields: context ? projectLocalizedDataCells(row.cells, table.fields, context, `rows.${row.id}.cells`) : row.cells } : {}),
      },
      localization,
    }
  },
}

// ---------------------------------------------------------------------------
// content_search_documents
// ---------------------------------------------------------------------------

const SearchDocumentsInput = Type.Object({
  query: Type.String({ minLength: 1 }),
  language: LanguageInput,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

const searchDocumentsTool: AiTool = {
  name: 'content_search_documents',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_READ_CAPS,
  description:
    'Search readable Content documents using their displayed titles and text fields. Pass language for localized collections; otherwise their catalogue metadata is returned without searching references. `limit` default 25, max 100.',
  inputSchema: SearchDocumentsInput,
  handler: async (input, ctx) => {
    const { query, limit, language } = input as Static<typeof SearchDocumentsInput>
    const user = dataToolUser(ctx)
    const tables = visibleContentTables(await listDataTablesWithCounts(ctx.db, ctx.branch), user)
    const localization = await localizationFor(ctx, tables, language)
    const context = languageContext(localization)
    const results: ReturnType<typeof projectRow>[] = []
    const needle = query.toLocaleLowerCase(context?.language)
    for (const table of tables) {
      if (hasLocalizedDataFields(table.fields) && !context) continue
      const rows = await listDataRows(ctx.db, ctx.branch, table.id, canSeeAllDataRows(user) ? {} : { ownerUserId: user.id })
      for (const row of rows) {
        if (!canReadDataRow(user, row)) continue
        const cells = context ? projectLocalizedDataCells(row.cells, table.fields, context, `rows.${row.id}.cells`) : row.cells
        const title = readDisplayTitle(row.cells, table, context)
        const text = [title, row.slug, ...dataCellTextValues(cells, table.fields)].join('\n')
        if (text.toLocaleLowerCase(context?.language).includes(needle)) results.push(projectRow(row, table, context))
      }
    }
    return {
      query,
      results: results.slice(0, limit ?? 25),
      localization,
    }
  },
}

// ---------------------------------------------------------------------------
// content_list_users
// ---------------------------------------------------------------------------

const ListUsersInput = Type.Object({})

const listUsersTool: AiTool = {
  name: 'content_list_users',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: ['users.manage'],
  description:
    'List active users available as document authors (id, email, displayName, roleSlug, roleName). Use to look up an author id before content_set_document_author.',
  inputSchema: ListUsersInput,
  handler: async (_input, ctx) => {
    const users = await listDataAuthorOptions(ctx.db)
    return { users }
  },
}

// ---------------------------------------------------------------------------
// content_list_media
// ---------------------------------------------------------------------------

const ListMediaInput = Type.Object({
  query: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

const listMediaTool: AiTool = {
  name: 'content_list_media',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: ['media.read'],
  description:
    "List existing media assets so you can pick one for a media-typed field. Returns id, filename, publicPath, mimeType, altText, width, height. Optional `query` substring-matches filename + altText (case-insensitive); `mimeType` substring-matches the mime (e.g. 'image' to filter to images). `limit` default 25, max 100. To add a new image, use media_upload.",
  inputSchema: ListMediaInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ListMediaInput>
    const all = await listMediaAssets(ctx.db)
    const lowerQuery = args.query?.toLowerCase()
    const lowerMime = args.mimeType?.toLowerCase()
    const filtered = all.filter((asset) => {
      if (lowerMime && !asset.mimeType.toLowerCase().includes(lowerMime)) return false
      if (lowerQuery) {
        const haystack = `${asset.filename ?? ''} ${asset.altText ?? ''}`.toLowerCase()
        if (!haystack.includes(lowerQuery)) return false
      }
      return true
    })
    const limit = args.limit ?? 25
    return {
      total: filtered.length,
      media: filtered.slice(0, limit).map((m) => ({
        id: m.id,
        filename: m.filename,
        publicPath: m.publicPath,
        mimeType: m.mimeType,
        altText: m.altText,
        width: m.width,
        height: m.height,
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const contentReadTools: AiTool[] = [
  listCollectionsTool,
  getCollectionSchemaTool,
  listDocumentsTool,
  getDocumentTool,
  searchDocumentsTool,
  listUsersTool,
  listMediaTool,
]
