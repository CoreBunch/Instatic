/**
 * Data-scope schema tools — server-resolved, headless.
 *
 * These close the read/write asymmetry the MCP surface had around table
 * schemas: `content_get_collection_schema` reads any table, but nothing could
 * create one or add a field to one, so provisioning a site over MCP always
 * stopped for a human to type tables into the Data workspace.
 *
 * Headless on purpose. A data table is edited in a grid, not in the Tiptap
 * editor whose dirty in-memory state forces the `content_*` write tools
 * through the browser bridge, so there is no live draft to keep consistent
 * with. Same execution class as `media_upload`: a server-resolved write that
 * works with no workspace tab open.
 *
 * Each tool mirrors the validation, guards, and audit emission of the HTTP
 * route it shadows (`server/handlers/cms/data/tables.ts`). The one thing it
 * cannot mirror is `requireStepUp` — there is no step-up challenge on an MCP
 * connection. The compensating controls are the `data.*.tables.manage`
 * capability gate (an approver can only grant capabilities they hold) and the
 * audit trail below, which records the connector id on every write.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import {
  DataFieldSchema,
  type DataField,
  type DataTable,
  type DataTableListItem,
  type UpdateDataTableInput,
} from '@core/data/schemas'
import { normalizeDataTableFields } from '@core/data/fields'
import { assertSystemTableUpdateAllowed } from '@core/data/systemTableGuard'
import { slugFromTitle } from '@core/utils/slug'
import { DataListTablesOutputSchema, DataTableOutputSchema } from '@core/ai'
import type { AiTool, ToolContext } from '../../runtime/types'
import { createAuditEvent } from '../../../repositories/audit'
import {
  createDataTable,
  getDataTable,
  getDataTableBySlug,
  listDataTablesWithCounts,
  updateDataTable,
} from '../../../repositories/data'
import {
  canManageTable,
  canReadTable,
  hasContentRowAccess,
} from '../../../handlers/cms/data/access'
import { toolActor } from './access'
import type { DataToolsRuntime } from './runtime'

// ---------------------------------------------------------------------------
// Capability requirements (ANY-OF) — each tool mirrors its HTTP-route gate in
// server/handlers/cms/data/access.ts.
// ---------------------------------------------------------------------------

// Mirrors `requireDataTablesRead` (TABLE_READ_CAPABILITIES). Holding any table
// read/manage cap is enough to enumerate; `canReadTable` then filters per
// family so a custom-only connector never sees the system tables.
const TABLE_READ_CAPS: readonly CoreCapability[] = [
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
]

// Mirrors `requireCustomTablesManager`. Creation is always a custom table —
// the system tables are seeded at boot and never created through an API.
const TABLE_CREATE_CAPS: readonly CoreCapability[] = ['data.custom.tables.manage']

// Schema mutation on an EXISTING table, whose family is only known once the
// table has been read. Holding either manage cap is enough to be offered the
// tool; `canManageTable` then decides per table, exactly as `handleTableItem`
// does after resolving it.
const TABLE_MANAGE_CAPS: readonly CoreCapability[] = [
  'data.custom.tables.manage',
  'data.system.tables.manage',
]

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * Field types reserved for the seeded system tables. `pageTree` stores a whole
 * page-node tree (the `body` of a `page` / `component` row) and `fieldSchema`
 * stores a `DataField[]` (a component's `params`). Both render as "open the
 * editor" buttons that only mean something inside those tables; put one on a
 * custom table and the grid shows a control that cannot be used and the value
 * cannot be authored anywhere. `normalizeDataTableFields` accepts them because
 * it also parses the system tables' own persisted schemas, so the refusal
 * belongs here, at the authoring boundary.
 */
const RESERVED_FIELD_TYPES: ReadonlySet<string> = new Set(['pageTree', 'fieldSchema'])

/**
 * The real field union, not `Type.Unknown()`.
 *
 * The HTTP route takes `fields` as unknown and lets `normalizeDataTableFields`
 * be the source of truth, which is right for a browser client that already
 * knows the shape. Over MCP the advertised schema is the ONLY spec an agent
 * reads, so an opaque `unknown` here means the agent has to guess the field
 * shape and finds out it guessed wrong from a table that silently dropped
 * every field. `normalizeDataTableFields` still runs after validation as the
 * coercion layer.
 */
const FieldArray = Type.Array(DataFieldSchema)

function projectTable(table: DataTableListItem) {
  return {
    id: table.id,
    slug: table.slug,
    label: table.pluralLabel || table.name,
    kind: table.kind,
    // Empty route base is the persisted sentinel for "not publicly routable".
    routable: table.routeBase !== '',
    system: table.system,
    rowCount: table.rowCount,
    primaryFieldId: table.primaryFieldId,
  }
}

function reservedFieldTypeError(fields: readonly DataField[]): string | null {
  const reserved = fields.find((field) => RESERVED_FIELD_TYPES.has(field.type))
  if (!reserved) return null
  return `Field "${reserved.id}" uses type "${reserved.type}", which is reserved for the built-in page/component tables and cannot be authored on a custom table.`
}

// ---------------------------------------------------------------------------
// data_list_tables
// ---------------------------------------------------------------------------

const ListTablesInput = Type.Object({
  kind: Type.Optional(Type.Union([Type.Literal('data'), Type.Literal('postType')])),
}, { additionalProperties: false })

/**
 * No `limit` and no cursor, deliberately. The row count of a table is content
 * and grows without bound; the NUMBER OF TABLES is schema, set by whoever
 * designed the site, and a workspace has tens of them at most. A limit-only
 * cap would make anything past the cap permanently unreachable while saving
 * nothing. The heavy half of a table — its `fields` array — is not in this
 * projection at all; that stays on `content_get_collection_schema`, one table
 * at a time.
 */
const listTablesTool: AiTool = {
  name: 'data_list_tables',
  scope: 'data',
  execution: 'server',
  requiredCapabilities: TABLE_READ_CAPS,
  description:
    "List every table in the workspace: reusable data tables (kind 'data') AND routable post types (kind 'postType'). Pass `kind` to narrow. Returns id, slug, label, kind, routable, system, rowCount, primaryFieldId per table — call content_get_collection_schema with an id for its fields, and content_list_documents / content_get_document with the same id to read its rows. This is the discovery tool for reusable data tables, which content_list_collections deliberately excludes. Headless — no editor needed.",
  inputSchema: ListTablesInput,
  outputSchema: DataListTablesOutputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { kind } = input as Static<typeof ListTablesInput>
    const actor = toolActor(ctx)
    const tables = await listDataTablesWithCounts(ctx.db, ctx.branch)

    // Per-family visibility, exactly as `GET /admin/api/cms/data/tables`
    // filters it: a custom-only caller never learns the system tables exist,
    // while a caller with content-row access (the loop / template pickers)
    // keeps the full list because choosing a loop source needs it.
    const readable = hasContentRowAccess(actor)
      ? tables
      : tables.filter((table) => canReadTable(actor, table))

    // `page`, `component`, and `layout` are Site-workspace internals with no
    // authorable rows — never part of this catalog, with or without a filter.
    return {
      tables: readable
        .filter((table) => (kind ? table.kind === kind : table.kind === 'data' || table.kind === 'postType'))
        .map(projectTable),
    }
  },
}

// ---------------------------------------------------------------------------
// data_create_table
// ---------------------------------------------------------------------------

const CreateTableInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
  kind: Type.Optional(Type.Union([Type.Literal('data'), Type.Literal('postType')])),
  routeBase: Type.Optional(Type.String()),
  singularLabel: Type.Optional(Type.String()),
  pluralLabel: Type.Optional(Type.String()),
  primaryFieldId: Type.Optional(Type.String()),
  fields: Type.Optional(FieldArray),
}, { additionalProperties: false })

function createTableTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_create_table',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: TABLE_CREATE_CAPS,
    description:
      "Create a custom table. `kind` defaults to 'data' (a reusable table with no public URLs — course dates, team members, pricing rows) — use 'postType' only for content that needs one public page per row. `slug` defaults to a slugified `pluralLabel`, `singularLabel`/`pluralLabel` default from `name`, `routeBase` defaults to `/<slug>` for a post type and to none for a data table (pass an explicit `routeBase` only to override that), `primaryFieldId` names the field used as the row label in grids and pickers (defaults to 'title'). Pass `fields` to define the schema up front. Returns the table AS STORED, including the actual field ids — read those back before wiring loops or writing rows, they are not always the ids you sent. Field types 'pageTree' and 'fieldSchema' are reserved for built-in tables. Headless — no editor needed.",
    inputSchema: CreateTableInput,
    outputSchema: DataTableOutputSchema,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof CreateTableInput>

      const name = args.name.trim()
      if (!name) return { ok: false, error: 'Table name is required.' }

      const singularLabel = args.singularLabel?.trim() || name.replace(/s$/i, '') || name
      const pluralLabel = args.pluralLabel?.trim() || name
      const slug = slugFromTitle(args.slug?.trim() || pluralLabel)
      const kind = args.kind === 'postType' ? 'postType' : 'data'

      // Same rule as the Data workspace's own New table dialog: a post type is
      // routable at `/<slug>`, a reusable data table is not routable at all.
      // Leaving this undefined is NOT equivalent — `createDataTable` then
      // derives `/<slug>` for both kinds, which would give every row of a
      // course-dates table its own public URL.
      const routeBase = args.routeBase ?? (kind === 'postType' ? `/${slug}` : '')

      const fields = normalizeDataTableFields(args.fields ?? [])
      const reserved = reservedFieldTypeError(fields)
      if (reserved) return { ok: false, error: reserved }

      // The partial unique index on active slugs would otherwise surface as an
      // opaque driver error, leaving the caller unable to tell a duplicate
      // from a bug. Same reasoning as the row-slug pre-check in the HTTP route.
      const clash = await getDataTableBySlug(ctx.db, ctx.branch, slug)
      if (clash) {
        return {
          ok: false,
          error: `A table with slug "${slug}" already exists (id ${clash.id}). Pass a different \`slug\`, or write to the existing table.`,
        }
      }

      const table = await createDataTable(ctx.db, ctx.branch, {
        name,
        slug,
        kind,
        routeBase,
        singularLabel,
        pluralLabel,
        primaryFieldId: args.primaryFieldId?.trim() || undefined,
        fields,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })

      await recordTableAudit(ctx, runtime, 'data.table.create', table.id, table.slug)
      return { table }
    },
  }
}

// ---------------------------------------------------------------------------
// data_update_table
// ---------------------------------------------------------------------------

const UpdateTableInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  slug: Type.Optional(Type.String({ minLength: 1 })),
  routeBase: Type.Optional(Type.String()),
  singularLabel: Type.Optional(Type.String({ minLength: 1 })),
  pluralLabel: Type.Optional(Type.String({ minLength: 1 })),
  primaryFieldId: Type.Optional(Type.String({ minLength: 1 })),
  fields: Type.Optional(FieldArray),
}, { additionalProperties: false })

function updateTableTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_update_table',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: TABLE_MANAGE_CAPS,
    description:
      "Change an existing table's identity or schema. `fields` REPLACES the whole field array — send every field you want to keep, or use data_add_fields to append without touching the rest. Dropping a field orphans the values already stored under it on every row. Set `routeBase` to an empty string to make a table non-routable, or to a path to give each row a public URL. The seeded system tables (pages, posts, components, layouts) accept custom fields but refuse any change to their identity or their built-in fields. Headless — no editor needed.",
    inputSchema: UpdateTableInput,
    outputSchema: DataTableOutputSchema,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof UpdateTableInput>
      const resolved = await resolveManageableTable(ctx, args.tableId)
      if ('error' in resolved) return resolved
      const { table } = resolved

      const update: Parameters<typeof updateDataTable>[3] = { updatedByUserId: ctx.userId }
      if (args.name !== undefined) update.name = args.name.trim()
      if (args.slug !== undefined) update.slug = slugFromTitle(args.slug.trim())
      if (args.routeBase !== undefined) update.routeBase = args.routeBase
      if (args.singularLabel !== undefined) update.singularLabel = args.singularLabel.trim()
      if (args.pluralLabel !== undefined) update.pluralLabel = args.pluralLabel.trim()
      if (args.primaryFieldId !== undefined) update.primaryFieldId = args.primaryFieldId.trim()
      if (args.fields !== undefined) update.fields = normalizeDataTableFields(args.fields)

      // `updatedByUserId` is always set, so one key means nothing was asked for.
      if (Object.keys(update).length === 1) {
        return { ok: false, error: 'Pass at least one property to change.' }
      }

      // A rename must not collide with another active slug, for the same
      // reason creation checks it: the unique index throws opaquely otherwise.
      if (update.slug && update.slug !== table.slug) {
        const clash = await getDataTableBySlug(ctx.db, ctx.branch, update.slug)
        if (clash) {
          return { ok: false, error: `A table with slug "${update.slug}" already exists (id ${clash.id}).` }
        }
      }

      const rejection = validateTableUpdate(table, update)
      if (rejection) return { ok: false, error: rejection }

      const updated = await updateDataTable(ctx.db, ctx.branch, table.id, update)
      if (!updated) return { ok: false, error: `Table ${args.tableId} not found.` }

      await recordTableAudit(ctx, runtime, 'data.table.update', updated.id, updated.slug)
      return { table: updated }
    },
  }
}

// ---------------------------------------------------------------------------
// data_add_fields
// ---------------------------------------------------------------------------

const AddFieldsInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  fields: Type.Array(DataFieldSchema, { minItems: 1 }),
}, { additionalProperties: false })

function addFieldsTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_add_fields',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: TABLE_MANAGE_CAPS,
    description:
      "Append fields to an existing table, leaving every current field and every stored value untouched. This is the safe way to evolve a schema — data_update_table's `fields` replaces the array and drops whatever you omit. A field id the table already has is refused rather than overwritten; change an existing field through data_update_table. Returns the table as stored. Headless — no editor needed.",
    inputSchema: AddFieldsInput,
    outputSchema: DataTableOutputSchema,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof AddFieldsInput>
      const resolved = await resolveManageableTable(ctx, args.tableId)
      if ('error' in resolved) return resolved
      const { table } = resolved

      const additions = normalizeDataTableFields(args.fields)
      if (additions.length === 0) {
        return { ok: false, error: 'None of the supplied fields is a usable field definition.' }
      }

      const existingIds = new Set(table.fields.map((field) => field.id))
      const duplicate = additions.find((field) => existingIds.has(field.id))
      if (duplicate) {
        return {
          ok: false,
          error: `Table "${table.slug}" already has a field with id "${duplicate.id}". Use data_update_table to change an existing field.`,
        }
      }

      const fields = [...table.fields, ...additions]
      const rejection = validateTableUpdate(table, { fields })
      if (rejection) return { ok: false, error: rejection }

      const updated = await updateDataTable(ctx.db, ctx.branch, table.id, {
        fields,
        updatedByUserId: ctx.userId,
      })
      if (!updated) return { ok: false, error: `Table ${args.tableId} not found.` }

      await recordTableAudit(ctx, runtime, 'data.table.update', updated.id, updated.slug)
      return { table: updated }
    },
  }
}

// ---------------------------------------------------------------------------
// Shared resolution + field validation
// ---------------------------------------------------------------------------

/**
 * Resolve a table this caller may reshape.
 *
 * The coarse `requiredCapabilities` gate cannot tell custom from system —
 * the family is a property of the row, not of the request — so the kind-aware
 * check happens here, mirroring `handleTableItem`. An unmanageable table
 * reports "not found" rather than "forbidden" for the same reason the HTTP
 * read path does: a caller who may not touch a family should not learn what
 * that family contains.
 */
async function resolveManageableTable(
  ctx: ToolContext,
  tableId: string,
): Promise<{ table: DataTable } | { ok: false; error: string }> {
  const table = await getDataTable(ctx.db, ctx.branch, tableId)
  if (!table || !canManageTable(toolActor(ctx), table)) {
    return { ok: false, error: `Table ${tableId} not found.` }
  }
  return { table }
}

/**
 * The reserved-type refusal plus the system table's frozen identity and
 * built-ins. Takes the whole patch, not just its fields, because a system
 * table freezes its name, slug, route base, and labels too — passing only
 * `fields` would let a rename through.
 *
 * The reserved check is skipped for system tables because their own `pageTree`
 * / `fieldSchema` built-ins are legitimately present and get re-sent on any
 * field write; `assertSystemTableUpdateAllowed` is what stops those from being
 * edited.
 */
function validateTableUpdate(
  table: DataTable,
  update: UpdateDataTableInput,
): string | null {
  if (update.fields && !table.system) {
    const reserved = reservedFieldTypeError(update.fields)
    if (reserved) return reserved
  }
  return assertSystemTableUpdateAllowed(table, update)
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Record a schema write. `source` and `connectorId` are what make an MCP write
 * distinguishable from an admin's own in the audit log — the HTTP routes get
 * that for free from `requestAuditContext(req)`, which has no tool equivalent.
 */
async function recordTableAudit(
  ctx: ToolContext,
  runtime: DataToolsRuntime | undefined,
  action: 'data.table.create' | 'data.table.update',
  tableId: string,
  slug: string,
): Promise<void> {
  await createAuditEvent(ctx.db, {
    actorUserId: ctx.userId,
    action,
    targetType: 'data_table',
    targetId: tableId,
    metadata: runtime?.connectorId
      ? { slug, source: 'mcp', connectorId: runtime.connectorId }
      : { slug, source: 'agent' },
  })
}

export function dataSchemaTools(runtime?: DataToolsRuntime): AiTool[] {
  return [
    listTablesTool,
    createTableTool(runtime),
    updateTableTool(runtime),
    addFieldsTool(runtime),
  ]
}
