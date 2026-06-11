/**
 * `/_instatic/hole-runtime.js` and `/_instatic/hole/<nodeId>` endpoints — Layer C server islands.
 *
 * The runtime asset is a tiny JavaScript module (< 1 KB) that uses
 * IntersectionObserver to lazily fetch rendered fragments for `<instatic-hole>`
 * elements in published pages.
 *
 * The fragment endpoint (`/_instatic/hole/<nodeId>?v=<version>&u=<page-url>`) renders
 * a single node subtree from the latest published snapshot AT REQUEST TIME and
 * returns it as HTML. The originating page URL (`u`) seeds the route frame so
 * `route.query.*` bindings resolve, drives per-loop pagination, and is fed to
 * request-dependent loop sources via `ctx.request`.
 *
 * Two cache tiers (see `LoopEntitySource.requestDependent` / `perVisitor`):
 *   - SHARED hole — cached by Layer B keyed on `(nodeId, page-query, version)`.
 *     The source's `fetch()` runs once per publish-version per distinct query.
 *   - PER-VISITOR hole — bypasses Layer B, reads request cookies, re-renders on
 *     every page load, and responds with `Cache-Control: no-store`.
 *
 * Version-awareness: the hole runtime stamps `data-instatic-version` on each
 * placeholder. The endpoint compares `?v=` to the current `publishVersion`; a
 * mismatch returns a lightweight stale sentinel so the next page load picks up
 * the new version.
 *
 * Inside the hole endpoint the RenderConfig has no `dynamicNodeIds` — the node
 * subtree is rendered fully (it is already the request-time dynamic part).
 *
 * Known v1 limitation: a hole that sits inside a per-entry content-template
 * page does not yet resolve `currentEntry.*` (no entry id is forwarded). Holes
 * are intended for `route.query`, live external data, and per-visitor content.
 */

import type { DbClient } from '../../db/client'
import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import type { SourceRequestContext } from '@core/loops/types'
import { registry } from '@core/module-engine'
import { loopSourceRegistry } from '@core/loops/registry'
import { renderNode, type RenderConfig, type RenderAccumulators } from '@core/publisher'
import { buildPageFrame, buildRouteFrame, buildSiteFrame } from '@core/templates/contextFrames'
import { prefetchLoopData } from '../../publish/loopPrefetch'
import { getOrRender } from '../../publish/renderCache'
import { getPublishedNodeIndexForVersion } from '../../publish/publishedSnapshotCache'
import { getPublishVersion } from '../../publish/publishState'
import { HOLE_RUNTIME_JS } from '../../publish/holeRuntime'

const HOLE_RUNTIME_PATH = '/_instatic/hole-runtime.js'
const HOLE_PATH_PREFIX = '/_instatic/hole/'

export function isHoleRuntimeAssetPath(pathname: string): boolean {
  return pathname === HOLE_RUNTIME_PATH
}

export function serveHoleRuntimeAsset(): Response {
  return new Response(HOLE_RUNTIME_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Cache for 1 hour — the path is a well-known fixed CMS asset that
      // only changes on a CMS version bump. Use deploy-time cache-busting
      // (e.g. append a build hash) if you need longer caching.
      'cache-control': 'public, max-age=3600',
    },
  })
}

export interface HoleHandlerContext {
  db: DbClient
}

// The versioned snapshot memo + nodeId → page index live in
// `publish/publishedSnapshotCache.ts`, shared with the public router and the
// loop endpoint — request-time lookup is O(1) and warm requests do zero DB I/O.

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Parse a `Cookie` header into a flat map. Returns `{}` when absent. */
function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/** Sorted, stable serialisation of a query string for cache keys. */
function normalizeQuery(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(entries).toString()
}

/**
 * Whether a hole must be rendered per visitor (bypass cache, read cookies).
 * Only `perVisitor` loop sources qualify — a module `render()` cannot read
 * cookies, so module holes are always shared-cacheable.
 */
function isPerVisitorHole(node: PageNode): boolean {
  if (node.moduleId !== 'base.loop') return false
  const sourceId = typeof node.props.sourceId === 'string' ? node.props.sourceId : ''
  if (!sourceId) return false
  return loopSourceRegistry.get(sourceId)?.perVisitor === true
}

/**
 * Render one node subtree at request time. Builds the same named frames the
 * full-page publisher builds (route/page/site) plus pre-fetched loop data for
 * loops INSIDE this subtree, then renders fully (no `<instatic-hole>` recursion).
 */
async function renderHoleFragment(
  nodeId: string,
  page: Page,
  site: SiteDocument,
  db: DbClient,
  pageUrl: URL,
  request: SourceRequestContext,
): Promise<string> {
  const route = buildRouteFrame(pageUrl.toString())
  const loopData = await prefetchLoopData(page, site, db, pageUrl, {
    request,
    rootNodeId: nodeId,
  })
  const config: RenderConfig = {
    page,
    site,
    registry,
    breakpointId: undefined,
    loopData,
    templateContext: {
      entryStack: [],
      page: buildPageFrame(page),
      site: buildSiteFrame(site),
      route,
    },
    // No dynamicNodeIds: inside a hole endpoint we render the full subtree.
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
  }
  return renderNode(nodeId, config, acc)
}

/**
 * Render a single dynamic node subtree for Layer C hole hydration.
 *
 * GET `/_instatic/hole/<nodeId>?v=<publishVersion>&u=<page-url>` → HTML fragment.
 */
export async function handleHoleRequest(
  req: Request,
  url: URL,
  ctx: HoleHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const nodeId = decodeURIComponent(url.pathname.slice(HOLE_PATH_PREFIX.length))
  if (!nodeId) {
    return new Response('Missing node id', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Version check — if the ?v= param doesn't match the current publish version,
  // return a lightweight stale sentinel without caching. The next full page load
  // will carry the correct version in its placeholder attributes.
  const requestVersion = url.searchParams.get('v') ?? ''
  const currentVersion = getPublishVersion()
  if (requestVersion !== String(currentVersion)) {
    return new Response('<instatic-hole-stale data-instatic-stale="true"></instatic-hole-stale>', {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  // Load (memoised) snapshot for this version and find the node's page in O(1).
  const snap = await getPublishedNodeIndexForVersion(ctx.db, currentVersion)
  if (!snap) {
    return new Response('Site not published', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  const foundPage = snap.nodeIndex.get(nodeId)
  if (!foundPage) {
    return new Response('Node not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  const node = foundPage.nodes[nodeId]!

  // Reconstruct the originating page URL forwarded by the runtime (`u`). Falls
  // back to the page's own permalink when absent (older runtime / direct hit).
  const pageUrlRaw = url.searchParams.get('u') ?? buildPageFrame(foundPage).permalink
  let pageUrl: URL
  try {
    pageUrl = new URL(pageUrlRaw, url.origin)
  } catch {
    pageUrl = new URL(buildPageFrame(foundPage).permalink, url.origin)
  }

  const perVisitor = isPerVisitorHole(node)
  const route = buildRouteFrame(pageUrl.toString())
  // Parsed query params of the originating page request — handed to a
  // request-dependent loop source's `fetch()` via `ctx.request.query`.
  const query: Record<string, string> = Object.fromEntries(pageUrl.searchParams)

  // Per-visitor hole: bypass Layer B entirely, expose cookies, never cache.
  if (perVisitor) {
    const request: SourceRequestContext = {
      query,
      path: route.path,
      slug: route.slug,
      cookies: parseCookies(req.headers.get('cookie')),
    }
    const html = await renderHoleFragment(nodeId, foundPage, snap.site, ctx.db, pageUrl, request)
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  // Shared hole: cache via Layer B keyed on the normalized PAGE query so
  // distinct queries get distinct slots while identical queries single-flight.
  // Cookies are intentionally NOT exposed (they would fragment the cache).
  const request: SourceRequestContext = {
    query,
    path: route.path,
    slug: route.slug,
    cookies: {},
  }
  const cached = await getOrRender(
    {
      urlPath: `${HOLE_PATH_PREFIX}${nodeId}`,
      queryString: `v=${currentVersion}&${normalizeQuery(pageUrl.searchParams)}`,
    },
    async () => {
      const html = await renderHoleFragment(nodeId, foundPage, snap.site, ctx.db, pageUrl, request)
      return {
        body: html,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        status: 200 as const,
      }
    },
  )

  if (!cached) {
    return new Response('Render failed', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(cached.body, {
    status: cached.status,
    headers: cached.headers,
  })
}
