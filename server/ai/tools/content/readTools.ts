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
import {
  getDataRow,
  listDataAuthorOptions,
  listDataRows,
  listDataTablesWithCounts,
  searchDataRows,
} from '../../../repositories/data'
import { listMediaAssets } from '../../../repositories/media'
import {
  readSlugCell,
  readTitleCell,
} from '@core/data/cells'
import { normalizeDataTableFields } from '@core/data/fields'
import type { DataField, DataRow, DataTableListItem } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — each tool mirrors its HTTP-route gate.
// ---------------------------------------------------------------------------

// Document (data-row) content read — mirrors `requireDataAccess`
// (DATA_ACCESS_CAPABILITIES in server/handlers/cms/data/access.ts).
const DOCUMENT_READ_CAPS: readonly CoreCapability[] = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
]

// Schema-level read — mirrors `requireDataTablesRead`.
const SCHEMA_READ_CAPS: readonly CoreCapability[] = ['data.tables.read', 'data.tables.manage']

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

/**
 * Decide which kinds of collections are visible to the content agent.
 * `data` (custom data tables) and `component` (visual-component definitions)
 * stay hidden — they belong to the Data + Site workspaces respectively.
 * Otherwise the agent would happily list every internal table.
 */
const CONTENT_KIND_VISIBLE: ReadonlySet<string> = new Set(['postType', 'page'])

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

function projectField(field: DataField) {
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
  return base
}

function projectRow(row: DataRow) {
  return {
    id: row.id,
    tableId: row.tableId,
    title: readTitleCell(row.cells) || readSlugCell(row.cells) || row.slug || row.id,
    slug: row.slug,
    status: row.status,
    authorUserId: row.authorUserId,
    updatedAt: row.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// list_collections
// ---------------------------------------------------------------------------

const ListCollectionsInput = Type.Object({})

const listCollectionsTool: AiTool = {
  name: 'list_collections',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: SCHEMA_READ_CAPS,
  description:
    'List every content collection (postType + page tables) with id, slug, label, kind, row count, and primary field id. Use to discover where a document lives before reading/writing.',
  inputSchema: ListCollectionsInput,
  handler: async (_input, ctx) => {
    const tables = await listDataTablesWithCounts(ctx.db)
    return {
      collections: tables
        .filter((t) => CONTENT_KIND_VISIBLE.has(t.kind))
        .map(projectCollection),
    }
  },
}

// ---------------------------------------------------------------------------
// get_collection_schema
// ---------------------------------------------------------------------------

const GetCollectionSchemaInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
})

const getCollectionSchemaTool: AiTool = {
  name: 'get_collection_schema',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: SCHEMA_READ_CAPS,
  description:
    "Return one collection's field schema: each field's id, label, type, required flag, builtIn flag, and per-type extras (select options, media kind, relation target). Call BEFORE set_document_field on an unfamiliar collection so you know the field's value shape.",
  inputSchema: GetCollectionSchemaInput,
  handler: async (input, ctx) => {
    const { tableId } = input as Static<typeof GetCollectionSchemaInput>
    const tables = await listDataTablesWithCounts(ctx.db)
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
    }
  },
}

// ---------------------------------------------------------------------------
// list_documents
// ---------------------------------------------------------------------------

const ListDocumentsInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
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
  name: 'list_documents',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_READ_CAPS,
  description:
    'List documents in one collection. Returns id, title, slug, status, authorUserId, updatedAt — light projection. Filter by status / authorUserId, paginate with limit (default 25, max 200) + offset.',
  inputSchema: ListDocumentsInput,
  handler: async (input, ctx) => {
    const args = input as Static<typeof ListDocumentsInput>
    const all = await listDataRows(ctx.db, args.tableId)
    let filtered = all
    if (args.status) filtered = filtered.filter((r) => r.status === args.status)
    if (args.authorUserId) filtered = filtered.filter((r) => r.authorUserId === args.authorUserId)
    const offset = args.offset ?? 0
    const limit = args.limit ?? 25
    const slice = filtered.slice(offset, offset + limit)
    return {
      total: filtered.length,
      offset,
      limit,
      documents: slice.map(projectRow),
    }
  },
}

// ---------------------------------------------------------------------------
// get_document
// ---------------------------------------------------------------------------

const GetDocumentInput = Type.Object({
  documentId: Type.String({ minLength: 1 }),
})

const getDocumentTool: AiTool = {
  name: 'get_document',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_READ_CAPS,
  description:
    "Return one document's full state: every field value (body is a markdown string), status, author, slug, timestamps. Use for the doc the user wants to edit when it isn't the active doc, or to refresh state after another agent action.",
  inputSchema: GetDocumentInput,
  handler: async (input, ctx) => {
    const { documentId } = input as Static<typeof GetDocumentInput>
    const row = await getDataRow(ctx.db, documentId)
    if (!row) {
      return { ok: false, error: `Document ${documentId} not found.` }
    }
    return {
      document: {
        id: row.id,
        tableId: row.tableId,
        title: readTitleCell(row.cells) || row.slug || row.id,
        slug: row.slug,
        status: row.status,
        authorUserId: row.authorUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        publishedAt: row.publishedAt,
        scheduledPublishAt: row.scheduledPublishAt,
        fields: row.cells,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// search_documents
// ---------------------------------------------------------------------------

const SearchDocumentsInput = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

const searchDocumentsTool: AiTool = {
  name: 'search_documents',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: DOCUMENT_READ_CAPS,
  description:
    "Full-text search across document slugs (the slug is a URL-safe derivative of the title — reliable text proxy for free-text lookup). Returns light summaries (id, tableId, slug, status, updatedAt). `limit` default 25, max 100.",
  inputSchema: SearchDocumentsInput,
  handler: async (input, ctx) => {
    const { query, limit } = input as Static<typeof SearchDocumentsInput>
    const results = await searchDataRows(ctx.db, query, limit ?? 25)
    // Only surface postType/page rows — `data` tables aren't content.
    const tables = await listDataTablesWithCounts(ctx.db)
    const visibleTableIds = new Set(
      tables.filter((t) => CONTENT_KIND_VISIBLE.has(t.kind)).map((t) => t.id),
    )
    return {
      query,
      results: results
        .filter((r) => visibleTableIds.has(r.tableId))
        .map((r) => ({
          id: r.id,
          tableId: r.tableId,
          tableSlug: r.tableSlug,
          tableName: r.tableName,
          slug: r.slug,
          status: r.status,
          updatedAt: r.updatedAt,
        })),
    }
  },
}

// ---------------------------------------------------------------------------
// list_users
// ---------------------------------------------------------------------------

const ListUsersInput = Type.Object({})

const listUsersTool: AiTool = {
  name: 'list_users',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: ['users.manage'],
  description:
    'List active users available as document authors (id, email, displayName, roleSlug, roleName). Use to look up an author id before set_document_author.',
  inputSchema: ListUsersInput,
  handler: async (_input, ctx) => {
    const users = await listDataAuthorOptions(ctx.db)
    return { users }
  },
}

// ---------------------------------------------------------------------------
// list_media
// ---------------------------------------------------------------------------

const ListMediaInput = Type.Object({
  query: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

const listMediaTool: AiTool = {
  name: 'list_media',
  scope: 'content',
  execution: 'server',
  requiredCapabilities: ['media.read'],
  description:
    "List existing media assets so you can pick one for a media-typed field. Returns id, filename, publicPath, mimeType, altText, width, height. Optional `query` substring-matches filename + altText (case-insensitive); `mimeType` substring-matches the mime (e.g. 'image' to filter to images). `limit` default 25, max 100. You CANNOT upload new media — only assign existing.",
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
