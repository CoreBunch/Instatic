/**
 * Site-scope read tools — server-side, resolve from the posted SiteAgentSnapshot.
 *
 * These tools are compact catalogs that describe things not present in the
 * current document's HTML: editable documents, insertable modules, design
 * tokens, loop sources, post types, and breakpoints. Full document HTML is
 * read through the browser-backed `site_read_document` tool so non-active documents
 * do not have to ride in every prompt snapshot.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { describeAgentDocuments } from '@core/ai'
import '@core/loops/sources'
import { buildDataMeta } from '@core/data/fields'
import type { DataMetaField } from '@core/data/schemas'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopSourceField } from '@core/loops/types'
import type { AiTool } from '../types'
import type { SiteAgentSnapshot } from './snapshot'
import { listDataTablesWithCounts } from '../../../repositories/data'
import {
  describeAgentModules,
  describeAgentTokens,
  filterTokenFamily,
  type TokenFamily,
} from './render'

function asSnap(snapshot: unknown): SiteAgentSnapshot {
  return snapshot as SiteAgentSnapshot
}

// ---------------------------------------------------------------------------
// site_list_documents
// ---------------------------------------------------------------------------

const ListDocumentsInput = Type.Object({})

const listDocumentsTool: AiTool = {
  name: 'site_list_documents',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List editable documents: pages, templates, and visual components. Use the returned document refs with site_read_document/site_open_document. Each item includes rootNodeId, active/current flags, template metadata, and a short summary.',
  inputSchema: ListDocumentsInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return {
      currentDocument: snap.currentDocument,
      documents: describeAgentDocuments(snap.site, snap.page.id, snap.currentDocument),
    }
  },
}

// ---------------------------------------------------------------------------
// site_list_modules
// ---------------------------------------------------------------------------

const ListModulesInput = Type.Object({
  category: Type.Optional(Type.String()),
})

const listModulesTool: AiTool = {
  name: 'site_list_modules',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List registered modules with id, name, category, props schema, and style targets. `category` filters case-insensitively.',
  inputSchema: ListModulesInput,
  handler: async (input) => {
    const { category } = input as Static<typeof ListModulesInput>
    const normalized = category?.toLowerCase()
    const all = describeAgentModules()
    const modules = normalized
      ? all.filter((m) => m.category.toLowerCase() === normalized)
      : all
    return { modules }
  },
}

// ---------------------------------------------------------------------------
// site_list_tokens
// ---------------------------------------------------------------------------

const ListTokensInput = Type.Object({
  family: Type.Optional(
    Type.Union([
      Type.Literal('colors'),
      Type.Literal('typography'),
      Type.Literal('spacing'),
      Type.Literal('fonts'),
    ]),
  ),
})

const listTokensTool: AiTool = {
  name: 'site_list_tokens',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    "List the site's design tokens — color tokens (with shades/tints), typography & spacing scale steps, and font tokens — each with its CSS variable (use as `var(--name)` in a <style> block) and the utility class(es) bound to it (e.g. `text-primary`, `text-l`, `padding-m`). Prefer these over hardcoded colors/sizes/fonts. `family` narrows to one of colors|typography|spacing|fonts.",
  inputSchema: ListTokensInput,
  handler: async (input, ctx) => {
    const { family } = input as Static<typeof ListTokensInput>
    const snap = asSnap(ctx.snapshot)
    return { tokens: filterTokenFamily(describeAgentTokens(snap.site), family as TokenFamily | undefined) }
  },
}

// ---------------------------------------------------------------------------
// site_list_post_types
// ---------------------------------------------------------------------------

const ListPostTypesInput = Type.Object({})

const listPostTypesTool: AiTool = {
  name: 'site_list_post_types',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List the post types (routable collections) a `postTypes` template can target. Each entry has { slug, label, routeBase, kind }; pass the `slug` values to site_set_page_template\'s `target.tableSlugs`. Only collections with a public route appear — non-routable data tables are excluded.',
  inputSchema: ListPostTypesInput,
  handler: async (_input, ctx) => {
    const tables = await listDataTablesWithCounts(ctx.db)
    const postTypes = tables
      .filter((t) => t.routeBase.trim() !== '')
      .map((t) => ({
        slug: t.slug,
        label: t.pluralLabel || t.name,
        routeBase: t.routeBase,
        kind: t.kind,
      }))
    return { postTypes }
  },
}

// ---------------------------------------------------------------------------
// site_list_loop_sources
// ---------------------------------------------------------------------------

const ListLoopSourcesInput = Type.Object({})

type AgentBindingFormat = NonNullable<LoopSourceField['format']>

interface AgentBindingField {
  id: string
  label: string
  token: string
  format?: AgentBindingFormat
  type?: DataMetaField['type']
}

function currentEntryToken(fieldId: string): string {
  return `{currentEntry.${fieldId}}`
}

function loopFieldToAgentField(field: LoopSourceField): AgentBindingField {
  return {
    id: field.id,
    label: field.label,
    token: currentEntryToken(field.id),
    ...(field.format ? { format: field.format } : {}),
  }
}

function dataMetaFieldFormat(field: DataMetaField): AgentBindingFormat | undefined {
  switch (field.type) {
    case 'richText':
      return 'html'
    case 'url':
      return 'url'
    case 'media':
      return 'media'
    default:
      return undefined
  }
}

function dataMetaFieldToAgentField(field: DataMetaField): AgentBindingField {
  const format = dataMetaFieldFormat(field)
  return {
    id: field.id,
    label: field.label,
    type: field.type,
    token: currentEntryToken(field.id),
    ...(format ? { format } : {}),
  }
}

function mergeBindingFields(fields: AgentBindingField[]): AgentBindingField[] {
  const byId = new Map<string, AgentBindingField>()
  for (const field of fields) byId.set(field.id, field)
  return Array.from(byId.values())
}

const listLoopSourcesTool: AiTool = {
  name: 'site_list_loop_sources',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List loop source ids and the valid dynamic data tokens for loop children. Use before creating a <instatic-loop>. For posts/custom tables use sourceId "data.rows" and pass the chosen table id as data-table-id; inside the loop use returned tokens like {currentEntry.title}, never {{post.title}}.',
  inputSchema: ListLoopSourcesInput,
  handler: async (_input, ctx) => {
    const sources = loopSourceRegistry.list().map((source) => ({
      id: source.id,
      label: source.label,
      description: source.description,
      requestDependent: source.requestDependent === true,
      perVisitor: source.perVisitor === true,
      fields: source.fields.map(loopFieldToAgentField),
      filterSchema: source.filterSchema,
      orderByOptions: source.orderByOptions,
    }))
    const tables = await listDataTablesWithCounts(ctx.db)
    const dataMeta = buildDataMeta(tables)
    const dataRowsSource = loopSourceRegistry.get('data.rows')
    const dataRowsFields = dataRowsSource?.fields.map(loopFieldToAgentField) ?? []
    return {
      usage: {
        loopElement: '<instatic-loop data-source-id="data.rows" data-table-id="<table id>" data-order-by="publishedAt" data-direction="desc" data-limit="3">...</instatic-loop>',
        tokenSyntax: '{currentEntry.field}',
        invalidTokenSyntax: '{{post.field}}',
      },
      sources,
      dataTables: dataMeta.tables.map((table) => ({
        id: table.id,
        slug: table.slug,
        name: table.name,
        kind: table.kind,
        singularLabel: table.singularLabel,
        pluralLabel: table.pluralLabel,
        primaryFieldId: table.primaryFieldId,
        routable: table.routable,
        versioned: table.versioned,
        rowCount: tables.find((t) => t.id === table.id)?.rowCount ?? 0,
        fields: mergeBindingFields([
          ...table.fields.map(dataMetaFieldToAgentField),
          ...dataRowsFields,
        ]),
      })),
    }
  },
}

// ---------------------------------------------------------------------------
// site_list_breakpoints
// ---------------------------------------------------------------------------

const ListBreakpointsInput = Type.Object({})

const listBreakpointsTool: AiTool = {
  name: 'site_list_breakpoints',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List configured breakpoints (id, label, frame width px, media query, icon) plus the active id. Same info is already in the system suffix; only call if you lost track.',
  inputSchema: ListBreakpointsInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return {
      activeBreakpointId: snap.activeBreakpointId,
      breakpoints: snap.site.breakpoints,
    }
  },
}

// ---------------------------------------------------------------------------
// All read tools — convenient barrel for the registry
// ---------------------------------------------------------------------------

export const siteReadTools: AiTool[] = [
  listDocumentsTool,
  listModulesTool,
  listTokensTool,
  listPostTypesTool,
  listLoopSourcesTool,
  listBreakpointsTool,
]
