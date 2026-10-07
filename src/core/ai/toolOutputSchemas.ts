/**
 * Result shapes for every AI tool, as TypeBox schemas.
 *
 * The counterpart to `toolSchemas.ts`: that file says what goes into a tool,
 * this one says what comes back. Only the MCP surface reads them — the server
 * advertises each as `outputSchema` in `tools/list` and ships the payload as
 * `structuredContent`, so an external client parses a typed object instead of
 * re-deriving the shape from a JSON text blob. Provider tool definitions carry
 * no output schema, so the in-app drivers ignore these entirely.
 *
 * They live in `src/core/` because a browser tool's result is produced in the
 * browser (the `agent` folder under each `src/admin/pages` workspace) and
 * advertised by the server
 * (`server/ai/`), and neither may import the other.
 *
 * **Nothing validates against these at runtime.** A drift between a schema and
 * what a handler returns must surface as a failing test, never as a tool that
 * stops working on a live install — so the tests assert the match and the wire
 * path does not. `server/ai/mcp/registry.test.ts` requires every advertised
 * tool to declare one.
 *
 * Depth is deliberate, not lazy. Where a tool projects its own result inline
 * (rows, tables, media, breakpoints) the schema is exact. Where it forwards a
 * structure another engine owns — a page-node tree, a module's prop schema, a
 * loop source's filter schema — the leaf is `Type.Unknown()` with a
 * description. Restating those here would give the client a second definition
 * to drift from the first.
 */

import { Type } from '@core/utils/typeboxHelpers'
import { AgentDocumentRefSchema } from './toolSchemas'

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * A tool that changes state and has nothing to report back.
 *
 * Most editor writes are like this: the caller named the node, the write
 * either applied or returned an error. `executeAiTool` normalises an empty
 * `aiToolOk()` to `{ ok: true }`, so that literal object is the payload.
 */
export const AcknowledgementOutputSchema = Type.Object({
  ok: Type.Boolean({ description: 'Always true — a failure comes back as an MCP tool error instead.' }),
})

const CssWriteOutputSchema = Type.Object({
  cssRulesCreated: Type.Optional(Type.Integer()),
  cssRulesUpdated: Type.Optional(Type.Integer()),
  cssRulesDeleted: Type.Optional(Type.Integer()),
  cssPropertiesRemoved: Type.Optional(Type.Integer()),
})

// ---------------------------------------------------------------------------
// data_* — reusable data tables
// ---------------------------------------------------------------------------

const DataTableSummarySchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  label: Type.String(),
  kind: Type.String({ description: "'data' for a reusable table, 'postType' for a routable one." }),
  routable: Type.Boolean({ description: 'False when rows have no public URL of their own.' }),
  system: Type.Boolean(),
  rowCount: Type.Integer(),
  primaryFieldId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/**
 * A table as stored, `fields` included. The field union itself is
 * `DataFieldSchema` (`@core/data/schemas`) — not restated here, because
 * `data_create_table` already advertises it as INPUT and the two must not
 * drift apart.
 */
const DataTableSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  kind: Type.String(),
  fields: Type.Array(Type.Unknown(), { description: 'DataField[] — the same shape data_create_table accepts.' }),
}, { additionalProperties: true })

const DataRowSchema = Type.Object({
  id: Type.String(),
  tableId: Type.String(),
  slug: Type.String(),
  status: Type.String({ description: "'draft' | 'published' | 'unpublished' | 'scheduled'" }),
  cells: Type.Record(Type.String(), Type.Unknown(), {
    description: 'Values keyed by field id, AS STORED — a plugin filter may have rewritten what you sent.',
  }),
  updatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

const RowFailureSchema = Type.Object({
  rowId: Type.String(),
  error: Type.String(),
})

export const DataListTablesOutputSchema = Type.Object({
  tables: Type.Array(DataTableSummarySchema),
})

export const DataTableOutputSchema = Type.Object({
  table: DataTableSchema,
})

export const DataCreateRowsOutputSchema = Type.Object({
  rows: Type.Array(DataRowSchema),
})

export const DataUpdateRowOutputSchema = Type.Object({
  row: DataRowSchema,
})

/**
 * Per-row outcomes, not one verdict. Publishing is not transactional — each
 * row bakes its own artefact — so a caller must be able to see exactly which
 * rows shipped before one failed.
 */
export const DataSetRowsStatusOutputSchema = Type.Object({
  updated: Type.Array(Type.Object({
    id: Type.String(),
    slug: Type.String(),
    status: Type.String(),
  })),
  failed: Type.Array(RowFailureSchema),
})

export const DataDeleteRowsOutputSchema = Type.Object({
  deleted: Type.Array(Type.Object({ id: Type.String(), slug: Type.String() })),
  failed: Type.Array(RowFailureSchema),
})

// ---------------------------------------------------------------------------
// content_*
// ---------------------------------------------------------------------------

const CollectionSummarySchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  label: Type.String(),
  kind: Type.String(),
  rowCount: Type.Integer(),
  primaryFieldId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

const CollectionFieldSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  type: Type.String(),
  required: Type.Boolean(),
  builtIn: Type.Boolean(),
  options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: Type.String() }))),
  mediaKind: Type.Optional(Type.String()),
  allowMultiple: Type.Optional(Type.Boolean()),
  targetTableId: Type.Optional(Type.String()),
}, { additionalProperties: true })

const DocumentSummarySchema = Type.Object({
  id: Type.String(),
  tableId: Type.String(),
  title: Type.String(),
  slug: Type.String(),
  status: Type.String(),
  authorUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  updatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: true })

const MediaAssetSchema = Type.Object({
  id: Type.String(),
  filename: Type.Union([Type.String(), Type.Null()]),
  publicPath: Type.String(),
  mimeType: Type.String(),
  altText: Type.Union([Type.String(), Type.Null()]),
  width: Type.Union([Type.Integer(), Type.Null()]),
  height: Type.Union([Type.Integer(), Type.Null()]),
})

export const ContentListCollectionsOutputSchema = Type.Object({
  collections: Type.Array(CollectionSummarySchema),
})

export const ContentGetCollectionSchemaOutputSchema = Type.Object({
  collection: Type.Composite([
    CollectionSummarySchema,
    Type.Object({ fields: Type.Array(CollectionFieldSchema) }),
  ]),
})

export const ContentListDocumentsOutputSchema = Type.Object({
  total: Type.Integer({ description: 'Matches before the limit/offset window.' }),
  offset: Type.Integer(),
  limit: Type.Integer(),
  documents: Type.Array(DocumentSummarySchema),
})

export const ContentGetDocumentOutputSchema = Type.Object({
  document: Type.Object({
    id: Type.String(),
    tableId: Type.String(),
    title: Type.String(),
    slug: Type.String(),
    status: Type.String(),
    authorUserId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    updatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    publishedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    scheduledPublishAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    fields: Type.Record(Type.String(), Type.Unknown(), {
      description: 'Every cell value keyed by field id; a body field arrives as a markdown string.',
    }),
  }, { additionalProperties: true }),
})

export const ContentSearchDocumentsOutputSchema = Type.Object({
  query: Type.String(),
  results: Type.Array(Type.Object({
    id: Type.String(),
    tableId: Type.String(),
    tableSlug: Type.Optional(Type.String()),
    tableName: Type.Optional(Type.String()),
    slug: Type.String(),
    status: Type.String(),
    updatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }, { additionalProperties: true })),
})

export const ContentListUsersOutputSchema = Type.Object({
  users: Type.Array(Type.Object({
    id: Type.String(),
    email: Type.String(),
    displayName: Type.String(),
    roleSlug: Type.Union([Type.String(), Type.Null()]),
    roleName: Type.Union([Type.String(), Type.Null()]),
  })),
})

export const ContentListMediaOutputSchema = Type.Object({
  total: Type.Integer(),
  media: Type.Array(MediaAssetSchema),
})

export const ContentCreateDocumentOutputSchema = Type.Object({
  documentId: Type.String(),
})

export const MediaUploadOutputSchema = MediaAssetSchema

// ---------------------------------------------------------------------------
// site_* — catalogs and reads
// ---------------------------------------------------------------------------

/**
 * `AgentDocumentDescriptor` from `documentRefs.ts`, which is an interface
 * rather than a schema — the extra keys stay open rather than restated.
 */
const DocumentDescriptorSchema = Type.Object({
  document: AgentDocumentRefSchema,
  title: Type.String(),
  rootNodeId: Type.String({ description: 'Pass this, NOT the page id, as a parent to site_insert_html.' }),
  active: Type.Boolean(),
  current: Type.Boolean(),
  summary: Type.String(),
  slug: Type.Optional(Type.String()),
  isHomepage: Type.Optional(Type.Boolean()),
  template: Type.Optional(Type.Unknown({ description: 'Present on templates: { target, priority }.' })),
}, { additionalProperties: true })

export const SiteListDocumentsOutputSchema = Type.Object({
  currentDocument: Type.Union([AgentDocumentRefSchema, Type.Null()], {
    description: 'Null over MCP — nothing is focused without an open editor. Ask get_context instead.',
  }),
  documents: Type.Array(DocumentDescriptorSchema),
})

export const SiteListModulesOutputSchema = Type.Object({
  modules: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    category: Type.String(),
  }, {
    additionalProperties: true,
    description: 'Also carries the module\'s prop schema and style targets, whose shape the module registry owns.',
  })),
})

/**
 * One digest per family, not a flat list: `filterTokenFamily` keeps the shape
 * stable and empties the families the caller did not ask for. Each entry
 * carries its CSS variable and the utility class(es) bound to it; the entry
 * shape itself belongs to the framework token describer.
 */
export const SiteListTokensOutputSchema = Type.Object({
  tokens: Type.Object({
    colors: Type.Array(Type.Unknown()),
    typography: Type.Array(Type.Unknown({ description: 'Scale groups, each with its steps.' })),
    spacing: Type.Array(Type.Unknown({ description: 'Scale groups, each with its steps.' })),
    fonts: Type.Array(Type.Unknown()),
  }, { additionalProperties: true }),
})

export const SiteListPostTypesOutputSchema = Type.Object({
  postTypes: Type.Array(Type.Object({
    slug: Type.String({ description: "Pass these to site_set_page_template's target.tableSlugs." }),
    label: Type.String(),
    routeBase: Type.String(),
    kind: Type.String(),
  })),
})

export const SiteListLoopSourcesOutputSchema = Type.Object({
  usage: Type.Object({
    loopElement: Type.String(),
    tokenSyntax: Type.String(),
    invalidTokenSyntax: Type.String(),
  }, { description: 'A worked <instatic-loop> example plus the token syntax that is and is not valid.' }),
  sources: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.String(),
    fields: Type.Array(Type.Unknown()),
  }, { additionalProperties: true })),
  dataTables: Type.Array(Type.Object({
    id: Type.String(),
    slug: Type.String(),
    name: Type.String(),
    fields: Type.Array(Type.Unknown({ description: 'Each carries the {currentEntry.x} token to use inside the loop.' })),
  }, { additionalProperties: true })),
})

/** The site-scope version reports the editor's active viewport; the MCP one does not. */
export const SiteListBreakpointsOutputSchema = Type.Object({
  activeBreakpointId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  breakpoints: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.String(),
    // `Number`, not `Integer`: the handler returns `site.breakpoints` verbatim
    // and `BreakpointSchema` types width as a number, so a fractional width is
    // storable and would fail an integer-shaped advertised schema.
    width: Type.Number(),
    isBase: Type.Optional(Type.Boolean({ description: 'The base context every other breakpoint cascades from.' })),
  }, { additionalProperties: true })),
})

/**
 * Two shapes behind one tool: `format: 'summary'` returns the class catalog,
 * anything else returns the stylesheet. Both keys are optional rather than a
 * union, so a client can read `css ?? classes` without branching on the input
 * it sent.
 */
export const SiteReadStylesOutputSchema = Type.Object({
  css: Type.Optional(Type.String({ description: 'The stylesheet, in the same syntax site_apply_css accepts back.' })),
  classes: Type.Optional(Type.Array(Type.Object({
    selector: Type.String(),
    kind: Type.String(),
    tokens: Type.Array(Type.String({ description: 'The --token variables this rule references.' })),
  }))),
  classCount: Type.Integer(),
})

export const SitePublishOutputSchema = Type.Object({
  publishedPages: Type.Integer({ description: 'Pages baked into the newly swapped static slot.' }),
})

export const GetContextOutputSchema = Type.Object({
  site: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  editor: Type.Object({
    siteConnected: Type.Boolean({ description: 'False means every browser site_* tool will refuse.' }),
    contentConnected: Type.Boolean(),
  }),
  templates: Type.Array(Type.Object({
    id: Type.String(),
    title: Type.String(),
    target: Type.String({ description: "'everywhere' wraps every page you author." }),
    tableSlugs: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
    priority: Type.Integer(),
  })),
  page: Type.Optional(Type.Object({
    found: Type.Boolean(),
    title: Type.Union([Type.String(), Type.Null()]),
    wrappedByTemplates: Type.Array(Type.String()),
  })),
})

// ---------------------------------------------------------------------------
// site_* — browser tools
// ---------------------------------------------------------------------------

/**
 * Two outcomes, one object. Markup inserts report node ids; HTML that held
 * only `<style>` rules reports rule counts instead. Both halves are optional
 * rather than a union because a JSON Schema union has no object root, and the
 * MCP wire requires one.
 */
export const SiteInsertHtmlOutputSchema = Type.Object({
  nodeIds: Type.Optional(Type.Array(Type.String())),
  created: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        moduleId: Type.String(),
        classes: Type.Array(Type.String()),
      }),
      { description: 'Every inserted node, so a nested one can be targeted without re-reading the tree. Absent on site_replace_node_html.' },
    ),
  ),
  warnings: Type.Optional(Type.Array(Type.String())),
  cssRulesCreated: Type.Optional(Type.Integer()),
  cssRulesUpdated: Type.Optional(Type.Integer()),
})

export const SiteGetNodeHtmlOutputSchema = Type.Object({
  html: Type.String(),
})

export const SiteReadDocumentOutputSchema = Type.Object({
  document: AgentDocumentRefSchema,
  title: Type.String(),
  html: Type.String({ description: 'The document rendered as HTML — the same form site_replace_node_html accepts.' }),
  css: Type.String(),
  pageInfo: Type.Optional(Type.Unknown({ description: 'Pagination for a document read in parts.' })),
})

export const SiteOpenDocumentOutputSchema = Type.Object({
  document: AgentDocumentRefSchema,
})

export const SiteApplyCssOutputSchema = CssWriteOutputSchema

export const SiteAddPageOutputSchema = Type.Object({
  pageId: Type.String(),
  rootNodeId: Type.String({ description: 'The parent to pass to site_insert_html — a page id is NOT a node id.' }),
})

export const SiteDuplicatePageOutputSchema = Type.Object({
  pageId: Type.String(),
})

export const SiteDuplicateNodeOutputSchema = Type.Object({
  nodeId: Type.String({ description: 'The first clone.' }),
  nodeIds: Type.Array(Type.String()),
})

export const SiteListCodeAssetsOutputSchema = Type.Object({
  assets: Type.Array(Type.Object({
    fileId: Type.String({ description: 'The id site_read_code_asset and site_patch_code_asset take.' }),
    path: Type.String(),
    type: Type.String(),
  }, { additionalProperties: true })),
})

export const SiteReadCodeAssetOutputSchema = Type.Object({
  fileId: Type.String(),
  path: Type.String(),
  type: Type.String(),
  content: Type.String({ description: 'One slice of the file — see pageInfo for the rest.' }),
  hash: Type.String({ description: 'Of the WHOLE file; pass it to site_patch_code_asset to detect a concurrent edit.' }),
  runtime: Type.Optional(Type.Unknown()),
  pageInfo: Type.Object({
    part: Type.Integer(),
    totalParts: Type.Integer(),
    nextPart: Type.Union([Type.Integer(), Type.Null()]),
    maxChars: Type.Integer(),
  }, { additionalProperties: true }),
})

export const SiteWriteCodeAssetOutputSchema = Type.Object({
  fileId: Type.String({ description: 'The id site_read_code_asset and site_patch_code_asset take.' }),
  path: Type.String(),
  action: Type.Optional(Type.String({ description: "'created' or 'updated'." })),
  replacements: Type.Optional(Type.Integer({ description: 'Patch only: how many matches were replaced.' })),
  dependencies: Type.Optional(Type.Unknown()),
}, { additionalProperties: true })

export const SiteInspectCodeRuntimeOutputSchema = Type.Object({
  pageId: Type.String(),
  document: AgentDocumentRefSchema,
  scripts: Type.Array(Type.Unknown()),
  styles: Type.Array(Type.Unknown()),
})

export const SiteSetColorTokensOutputSchema = Type.Object({
  tokens: Type.Array(Type.Object({
    ref: Type.String({ description: 'Ready to paste into CSS, e.g. var(--brand).' }),
  }, { additionalProperties: true })),
})

export const SiteSetFontTokensOutputSchema = Type.Object({
  tokens: Type.Array(Type.Object({
    name: Type.String(),
    variable: Type.String(),
    ref: Type.String(),
  }, { additionalProperties: true })),
})

export const SiteSetScaleOutputSchema = Type.Object({
  groupId: Type.String(),
  action: Type.String(),
  namingConvention: Type.String(),
  generatedVars: Type.Array(Type.String({ description: 'The CSS variables this scale now emits.' })),
})

export const SiteRenderSnapshotOutputSchema = Type.Object({
  screenshot: Type.Optional(Type.Unknown({
    description: 'Metadata only. The PNG itself rides as an MCP image block, and is a thumbnail — read the layout tree for detail.',
  })),
}, {
  additionalProperties: true,
  description: 'The rendered layout tree for the requested breakpoint, plus screenshot metadata.',
})
