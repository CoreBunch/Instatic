/**
 * Site-scope read tools — server-side, resolve from the posted SiteAgentSnapshot.
 *
 * `read_page` is the primary surface: it renders the active page into the
 * published HTML the agent edits (annotated `<body>` + `<style>` bundle). The
 * other tools are catalogs that describe things NOT present in the page's own
 * HTML (insertable modules, design tokens, sibling pages, loop sources,
 * breakpoints). Each tool casts `ctx.snapshot` to SiteAgentSnapshot at the top
 * of its handler — the runtime is scope-agnostic and hands tools an `unknown`
 * snapshot.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
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
  renderAgentPage,
  type TokenFamily,
} from './render'

function asSnap(snapshot: unknown): SiteAgentSnapshot {
  return snapshot as SiteAgentSnapshot
}

// ---------------------------------------------------------------------------
// read_page
// ---------------------------------------------------------------------------

const ReadPageInput = Type.Object({
  part: Type.Optional(Type.Integer({ minimum: 1 })),
})

const readPageTool: AiTool = {
  name: 'read_page',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'Return the active page as the published HTML the agent edits: an annotated <body> where every element carries uid="<nodeId>" (pass that id verbatim to write tools), plus page-relevant CSS in a <style> block. The result is size-budgeted and includes pageInfo; when pageInfo.nextPart is not null, call read_page({ part: pageInfo.nextPart }) to continue. Browser-only @font-face blocks, unrelated cross-page selectors, long base64/data URLs, and very long URLs are omitted or summarized. Class handles are the class names you see in the CSS / `class=` attributes.',
  inputSchema: ReadPageInput,
  handler: async (input, ctx) => {
    const { part } = input as Static<typeof ReadPageInput>
    const snap = asSnap(ctx.snapshot)
    return renderAgentPage(snap, { part })
  },
}

// ---------------------------------------------------------------------------
// list_modules
// ---------------------------------------------------------------------------

const ListModulesInput = Type.Object({
  category: Type.Optional(Type.String()),
})

const listModulesTool: AiTool = {
  name: 'list_modules',
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
// list_tokens
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
  name: 'list_tokens',
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
// list_pages
// ---------------------------------------------------------------------------

const ListPagesInput = Type.Object({})

const listPagesTool: AiTool = {
  name: 'list_pages',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List every page (id, title, slug, active, isHomepage). Homepage = slug "index". Use for site-level admin (duplicate, rename, set homepage).',
  inputSchema: ListPagesInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    const pages = snap.site.pages.map((p) => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      active: p.id === snap.page.id,
      isHomepage: p.slug === 'index',
      // null for an ordinary page; otherwise the template config so the agent
      // can see which pages are templates and what they target.
      template: p.template
        ? { target: p.template.target, priority: p.template.priority }
        : null,
    }))
    return { pages }
  },
}

// ---------------------------------------------------------------------------
// list_post_types
// ---------------------------------------------------------------------------

const ListPostTypesInput = Type.Object({})

const listPostTypesTool: AiTool = {
  name: 'list_post_types',
  scope: 'site',
  execution: 'server',
  requiredCapabilities: ['site.read'],
  description:
    'List the post types (routable collections) a `postTypes` template can target. Each entry has { slug, label, routeBase, kind }; pass the `slug` values to setPageTemplate\'s `target.tableSlugs`. Only collections with a public route appear — non-routable data tables are excluded.',
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
// list_loop_sources
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
  name: 'list_loop_sources',
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
// list_breakpoints
// ---------------------------------------------------------------------------

const ListBreakpointsInput = Type.Object({})

const listBreakpointsTool: AiTool = {
  name: 'list_breakpoints',
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
  readPageTool,
  listModulesTool,
  listTokensTool,
  listPagesTool,
  listPostTypesTool,
  listLoopSourcesTool,
  listBreakpointsTool,
]
