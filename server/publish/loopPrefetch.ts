/**
 * Server-side loop pre-fetch.
 *
 * Walks a page tree, finds every `base.loop` node, dispatches to the
 * registered LoopEntitySource's `fetch()`, and returns a map keyed by
 * loop nodeId → fetched items + pagination metadata. The publisher's
 * loop interceptor then reads from this map without performing any I/O.
 *
 * Pre-fetching all loop data up front means the renderer stays a pure
 * synchronous walk and CSS dedup keeps working unchanged.
 */

import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import type {
  LoopEntitySource,
  LoopFetchResult,
  LoopItem,
  SourceFetchContext,
  SourceRequestContext,
} from '@core/loops/types'
import { loopSourceRegistry } from '@core/loops/registry'
import { firstImagePathFromMarkdown } from '@core/markdown/renderMarkdown'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { publicDataUserFromParts } from '@core/data/publicDataUser'
import type { PublishedDataRow } from '@core/data/schemas'
import type { DbClient } from '../db/client'
import { walkRenderTree } from './renderTreeWalk'

/**
 * Resolved loop data for a single loop node on a page.
 *
 * `pageNumber` is 1-indexed. `hasMore` enables the infinite-loading
 * sentinel; `totalItems` powers the future numeric paginator block.
 */
interface ResolvedLoopData extends LoopFetchResult {
  pageNumber: number
  hasMore: boolean
}

type LoopDataMap = Map<string, ResolvedLoopData>

/**
 * Project a published data row into a LoopItem. The single-row route uses
 * this to seed the publisher's entry stack with one frame representing the
 * row being viewed.
 *
 * `cells` are spread first so all table-defined fields are available in
 * bindings by their field id. System fields (id, tableId, author, etc.)
 * are overlaid after so they can never be shadowed by a user-defined cell.
 */
export function publishedDataRowToLoopItem(row: PublishedDataRow): LoopItem {
  const tableRouteBase = normalizeRouteBase(row.tableRouteBase || `/${row.tableSlug}`)
  const permalink = `${tableRouteBase === '/' ? '' : tableRouteBase}/${row.slug}`

  // For post-type rows the `body` cell holds markdown — extract the first
  // inline image to populate the `firstImage` aliases.
  const bodyValue = row.cells['body']
  const firstImagePath = typeof bodyValue === 'string'
    ? firstImagePathFromMarkdown(bodyValue)
    : null

  const author = publicDataUserFromParts(row.authorName, row.authorRoleSlug, row.authorRoleName)
  const publishedBy = publicDataUserFromParts(
    row.publishedByName,
    row.publishedByRoleSlug,
    row.publishedByRoleName,
  )

  return {
    id: row.rowId,
    fields: {
      // Cells — primary data, spread first so bindings can reference any
      // user-defined field by its fieldId.
      ...row.cells,
      // System identity (overlay after cells so these are never shadowed)
      id: row.rowId,
      rowId: row.rowId,
      versionId: row.id,
      versionNumber: row.versionNumber,
      tableId: row.tableId,
      tableSlug: row.tableSlug,
      // People
      author,
      authorName: author?.displayName ?? null,
      authorRoleSlug: author?.roleSlug ?? null,
      authorRoleName: author?.roleName ?? null,
      publishedBy,
      publishedByName: publishedBy?.displayName ?? null,
      publishedByRoleSlug: publishedBy?.roleSlug ?? null,
      publishedByRoleName: publishedBy?.roleName ?? null,
      // Media aliases — denormalized from the row for resolved paths
      featuredMediaId: row.featuredMediaId,
      featuredMedia: row.featuredMediaPath,
      featuredMediaPath: row.featuredMediaPath,
      featuredMediaUrl: row.featuredMediaPath,
      firstImage: firstImagePath,
      firstImagePath,
      firstImageUrl: firstImagePath,
      // Dates / routing
      slug: row.slug,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      permalink,
    },
  }
}

/**
 * Recursively collect all `base.loop` nodes reachable from `rootNodeId`.
 * Walks via `node.children` (flat-map traversal — same as the publisher).
 *
 * `rootNodeId` defaults to the page root. The Layer C hole endpoint passes
 * the hole's own node id so only loops INSIDE the rendered subtree are
 * fetched — never loops elsewhere on the page (which would hit external
 * APIs needlessly and aren't part of the fragment).
 */
export function collectLoopNodes(
  page: Page,
  site: SiteDocument,
  rootNodeId: string = page.rootNodeId,
): PageNode[] {
  const result: PageNode[] = []
  const seen = new Set<string>()
  // Descend into referenced VC definition trees so a base.loop inside a VC body
  // is fetched too (ISS-022); a VC referenced twice yields one entry per id.
  walkRenderTree(page.nodes, rootNodeId, site, (node) => {
    if (node.moduleId === 'base.loop' && !seen.has(node.id)) {
      seen.add(node.id)
      result.push(node as PageNode)
    }
  })
  return result
}

/**
 * Read a loop node's properties as a strongly-typed shape. Every field
 * has a sensible default so a node missing properties (e.g. just-inserted)
 * still resolves to "no data" instead of crashing the render.
 */
interface LoopProps {
  sourceId: string
  filters: Record<string, unknown>
  orderBy: string
  direction: 'asc' | 'desc'
  limit: number
  offset: number
  pagination: 'none' | 'infinite'
  pageSize: number
}

export function readLoopProps(node: PageNode): LoopProps {
  const props = node.props
  return {
    sourceId: typeof props.sourceId === 'string' ? props.sourceId : '',
    filters:
      props.filters && typeof props.filters === 'object' && !Array.isArray(props.filters)
        ? (props.filters as Record<string, unknown>)
        : {},
    orderBy: typeof props.orderBy === 'string' ? props.orderBy : '',
    direction: props.direction === 'asc' ? 'asc' : 'desc',
    limit: typeof props.limit === 'number' && props.limit > 0 ? Math.floor(props.limit) : 10,
    offset: typeof props.offset === 'number' && props.offset >= 0 ? Math.floor(props.offset) : 0,
    pagination: props.pagination === 'infinite' ? 'infinite' : 'none',
    pageSize:
      typeof props.pageSize === 'number' && props.pageSize > 0 ? Math.floor(props.pageSize) : 10,
  }
}

/**
 * URL query parameter prefix for per-loop pagination state, e.g.
 * `?loop_<nodeId>_page=2`. Multiple loops on a single page each get their
 * own param so they paginate independently.
 */
function loopPageQueryKey(loopNodeId: string): string {
  return `loop_${loopNodeId}_page`
}

/** True for a `loop_<nodeId>_page` pagination param. */
function isLoopPageQueryKey(key: string): boolean {
  return /^loop_.+_page$/.test(key)
}

/**
 * Canonical render-cache query: keep ONLY the loop pagination params the
 * renderer consumes, sorted, and re-serialised (with a leading `?`, or `''`
 * when none remain). Arbitrary junk params (`?utm=…`, `?x=1`) therefore
 * collapse onto a single cache key, and a query that canonicalises to empty is
 * eligible for the Layer A disk fast-path — eliminating the attacker-controlled
 * key-space explosion against the shared LRU (ISS-032).
 */
export function canonicalRenderQuery(searchParams: URLSearchParams): string {
  const kept: Array<[string, string]> = []
  for (const [key, value] of searchParams) {
    if (isLoopPageQueryKey(key)) kept.push([key, value])
  }
  if (kept.length === 0) return ''
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  return `?${new URLSearchParams(kept).toString()}`
}

function readPageNumber(url: URL | undefined, loopNodeId: string): number {
  if (!url) return 1
  const raw = url.searchParams.get(loopPageQueryKey(loopNodeId))
  if (!raw) return 1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/**
 * Resolve one loop node by dispatching to its registered source and
 * applying the requested page slice.
 *
 * - `pagination: 'none'` → fetch up to `limit`, single page, never `hasMore`.
 * - `pagination: 'infinite'` → fetch `pageSize` items at `offset + (page-1)*pageSize`,
 *   `hasMore` reflects whether more rows remain.
 *
 * Errors from a source are swallowed and the loop renders empty — one
 * misconfigured loop must not crash the whole page.
 */
async function resolveOneLoop(
  node: PageNode,
  source: LoopEntitySource,
  ctx: { db: DbClient; site: SiteDocument; url?: URL; request?: SourceRequestContext },
): Promise<ResolvedLoopData> {
  const props = readLoopProps(node)
  const pageNumber = props.pagination === 'infinite' ? readPageNumber(ctx.url, node.id) : 1

  let limit = props.limit
  let offset = props.offset
  if (props.pagination === 'infinite') {
    limit = props.pageSize
    offset = props.offset + (pageNumber - 1) * props.pageSize
  }

  const fetchCtx: SourceFetchContext = {
    db: ctx.db,
    site: ctx.site,
    filters: props.filters,
    orderBy: props.orderBy || (source.orderByOptions[0]?.id ?? ''),
    direction: props.direction,
    limit,
    offset,
    // Request context — present only when rendering inside a Layer C hole.
    // Built-in publish-time sources ignore it.
    request: ctx.request,
  }

  try {
    const result = await source.fetch(fetchCtx)
    const consumed = offset + result.items.length
    return {
      items: result.items,
      totalItems: result.totalItems,
      pageNumber,
      hasMore: props.pagination === 'infinite' && consumed < result.totalItems,
    }
  } catch (err) {
    console.error(`[loopPrefetch] source "${source.id}" failed for node "${node.id}":`, err)
    return { items: [], totalItems: 0, pageNumber, hasMore: false }
  }
}

/**
 * Pre-fetch all loop data for a page in parallel. Returned map is keyed
 * by loop node id; the publisher's renderer reads from it during the
 * synchronous walk.
 *
 * `url` is optional — when present, per-loop `?loop_<id>_page` query
 * params drive infinite-loading slices. When absent (e.g. SSR for
 * editor preview) every loop renders page 1.
 */
export async function prefetchLoopData(
  page: Page,
  site: SiteDocument,
  db: DbClient,
  url?: URL,
  options?: {
    /** Per-request context for request-dependent sources (Layer C holes). */
    request?: SourceRequestContext
    /** Limit the walk to a subtree (the hole node id). Defaults to page root. */
    rootNodeId?: string
  },
): Promise<LoopDataMap> {
  const nodes = collectLoopNodes(page, site, options?.rootNodeId)
  if (nodes.length === 0) return new Map()

  const entries: Array<[string, ResolvedLoopData]> = await Promise.all(
    nodes.map(async (node) => {
      const props = readLoopProps(node)
      const source = props.sourceId ? loopSourceRegistry.get(props.sourceId) : undefined
      if (!source) {
        return [
          node.id,
          { items: [], totalItems: 0, pageNumber: 1, hasMore: false },
        ] as [string, ResolvedLoopData]
      }
      const data = await resolveOneLoop(node, source, {
        db,
        site,
        url,
        request: options?.request,
      })
      return [node.id, data] as [string, ResolvedLoopData]
    }),
  )

  return new Map(entries)
}
