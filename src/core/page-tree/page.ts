/**
 * Page — a NodeTree (flat `nodes` + `rootNodeId`) plus page-level metadata
 * (id, slug, title, optional template config). The structural shape matches
 * `NodeTreeSchema`; the only refinement is that the page's nodes carry the
 * richer `PageNode` type (BaseNode + optional `dynamicBindings` for template
 * data binding), and `rootNodeId` always points at a `base.body` node.
 *
 * The shared `NodeTreeSchema.properties` are spread in so that `Page` and
 * `NodeTreeSchema` cannot drift out of sync. The `nodes` field is overridden
 * with the page-specific `PageNodeSchema` (vs. the BaseNode-typed version in
 * `NodeTreeSchema`) — `PageNode` is structurally a superset of `BaseNode`, so
 * anything that consumes the page as a generic `NodeTree<BaseNode>` still
 * works.
 *
 * Architecture source: docs/superpowers/plans/2026-05-06-tree-unification.md
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { NodeTreeSchema } from './treeSchema'
import { PageNodeSchema, type PageNode, parsePageNode } from './pageNode'
import { PageTemplateConfigSchema, parsePageTemplate } from './pageTemplate'
import { reindexNodeParents } from './parentIndex'

// ---------------------------------------------------------------------------
// PageAccessSchema (Phase 3 — D14)
// ---------------------------------------------------------------------------

/**
 * Per-page access control (D14). A page is either `public` (anyone) or
 * restricted to a set of member group ids — a logged-in visitor in ANY of
 * the listed groups may view the page; everyone else is gated (anonymous →
 * login, logged-in-but-not-in-group → the built-in "no access" page). The
 * field is optional: a missing `access` (every pre-Phase-3 page) is treated
 * as `public`, so the field is fully backward-compatible and needs no JSON
 * migration (the `024_page_access` migration only backfills pages that were
 * previously protected by a prefix).
 */
export const PageAccessSchema = Type.Object({
  level: Type.Union([Type.Literal('public'), Type.Literal('groups')]),
  /** Group ids allowed to view the page. Ignored when `level === 'public'`. */
  groups: Type.Optional(Type.Array(Type.String())),
})

export type PageAccess = Static<typeof PageAccessSchema>

// ---------------------------------------------------------------------------
// PageSchema
// ---------------------------------------------------------------------------

export const PageSchema = Type.Object({
  ...NodeTreeSchema.properties,
  /** Override the BaseNode-typed `nodes` with the page-specific PageNode type. */
  nodes: Type.Record(Type.String(), PageNodeSchema),
  id: Type.String(),
  /** URL-safe slug — used as the public URL path when published */
  slug: Type.String(),
  /** Display title e.g. "Home", "About Us" */
  title: Type.String(),
  /** Owning user for admin/editor workflows; server-owned when persisted in CMS. */
  ownerUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** User who originally created this page; server-owned when persisted in CMS. */
  createdByUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** User who last saved this page draft; server-owned when persisted in CMS. */
  updatedByUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /**
   * Optional CMS template configuration.
   * Missing means a normal static page.
   * Silently dropped if invalid — handled in parsePage.
   */
  template: Type.Optional(PageTemplateConfigSchema),
  /**
   * Optional per-page access control (D14). Missing → public (the default).
   * Silently dropped to public when invalid — handled in parsePage.
   */
  access: Type.Optional(PageAccessSchema),
})

export type Page = Static<typeof PageSchema>

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Page. Throws `Error('<path>: <message>')` for required-field
 * failures using path segments relative to the page's position (e.g.
 * `nodes.heading-1.id`). Invalid optional fields (template) silently become
 * absent.
 *
 * Exported so `validatePages` in `@core/persistence/validate` can parse
 * individual pages (loaded from `data_rows`) with the same resilient
 * semantics.
 */
export function parsePage(raw: unknown, pageIndex: number): Page {
  const pagePathPrefix = `pages[${pageIndex}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${pagePathPrefix}: not an object`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') throw new Error(`${pagePathPrefix}.id: Expected string`)
  if (typeof r.slug !== 'string') throw new Error(`${pagePathPrefix}.slug: Expected string`)
  if (typeof r.title !== 'string') throw new Error(`${pagePathPrefix}.title: Expected string`)
  if (typeof r.rootNodeId !== 'string') throw new Error(`${pagePathPrefix}.rootNodeId: Expected string`)
  if (!r.nodes || typeof r.nodes !== 'object' || Array.isArray(r.nodes)) {
    throw new Error(`${pagePathPrefix}.nodes: Expected object`)
  }

  const nodes: Record<string, PageNode> = {}
  for (const [nodeId, rawNode] of Object.entries(r.nodes as Record<string, unknown>)) {
    // parsePageNode throws with path e.g. 'nodes.heading-1.id: Expected string'
    const node = parsePageNode(rawNode, `${pagePathPrefix}.nodes.${nodeId}`)
    nodes[nodeId] = node
  }

  // Derive the parentId index from the children arrays — never trust a stored
  // parentId value. Backfills data persisted before this field existed.
  reindexNodeParents(nodes)

  const template = parsePageTemplate(r.template)
  const access = parsePageAccess(r.access)

  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    ...(typeof r.ownerUserId === 'string' || r.ownerUserId === null ? { ownerUserId: r.ownerUserId } : {}),
    ...(typeof r.createdByUserId === 'string' || r.createdByUserId === null
      ? { createdByUserId: r.createdByUserId }
      : {}),
    ...(typeof r.updatedByUserId === 'string' || r.updatedByUserId === null
      ? { updatedByUserId: r.updatedByUserId }
      : {}),
    nodes,
    rootNodeId: r.rootNodeId,
    ...(template !== null ? { template } : {}),
    ...(access !== null ? { access } : {}),
  }
}

/**
 * Tolerant parser for a page's `access` field (D14). Returns the parsed
 * access object only when it describes a non-public restriction; a missing,
 * malformed, or `level: 'public'` value returns `null` (which `parsePage`
 * omits — omitting is semantically identical to `public` and keeps published
 * snapshots lean). A `groups` level with a non-array / empty groups list is
 * treated as public (fail-open is wrong here — fail-closed to public would
 * lock owners out of their own pages on a corrupt write; the middleware
 * treats an empty `groups` list as "no one", so a `groups` level with no ids
 * is normalised to public to avoid an accidental lockout).
 */
function parsePageAccess(raw: unknown): PageAccess | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.level !== 'groups') return null // 'public' or unknown → public (omitted)
  const groups = Array.isArray(r.groups) ? r.groups.filter((g): g is string => typeof g === 'string') : []
  if (groups.length === 0) return null // no groups → treat as public (avoid lockout)
  return { level: 'groups', groups }
}

/**
 * Resolve an arbitrary value (a raw `Page.access` field, possibly from a
 * published-site snapshot that was never re-parsed) into a normalised access
 * shape. Missing / malformed / public → `{ level: 'public', groups: [] }`.
 * Request-time consumers (the visitor-auth middleware) use this so a corrupt
 * or pre-Phase-3 snapshot never crashes the gate. Kept here so the access
 * normalisation rule lives in exactly one place alongside {@link parsePageAccess}.
 */
export function resolvePageAccess(raw: unknown): { level: 'public' | 'groups'; groups: string[] } {
  const parsed = parsePageAccess(raw)
  if (!parsed) return { level: 'public', groups: [] }
  return { level: 'groups', groups: parsed.groups ?? [] }
}
