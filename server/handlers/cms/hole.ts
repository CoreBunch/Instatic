/**
 * `/_instatic/hole-runtime.js` and `/_instatic/hole/<nodeId>` endpoints — Layer C server islands.
 *
 * The runtime asset is a tiny JavaScript module (~1.1 KB) that uses
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
 * placeholder. The endpoint compares `?v=` to the frozen site's content hash;
 * a mismatch returns a lightweight stale sentinel so the next page load picks up
 * the new version.
 *
 * Inside the hole endpoint the RenderConfig has no `dynamicNodeIds` — the node
 * subtree is rendered fully (it is already the request-time dynamic part).
 *
 * Known v1 limitation: a hole that sits inside a per-entry content-template
 * page does not yet resolve `currentEntry.*` (no entry id is forwarded). Holes
 * are intended for `route.query`, live external data, and per-visitor content.
 *
 * Fragments get form page tokens stamped (stampFormPageTokens) so CMS forms
 * inside holes can submit; the form runtime itself reaches the page via the
 * module-JS channel's static hole-subtree walk.
 */

import type { DbClient } from '../../db/client'
import type { Page, SiteDocument } from '@core/page-tree'
import type { ClosedContent } from '@core/loops/types'
import { registry } from '@core/module-engine'
import {
  renderNode,
  showWhenPathsAllow,
  showWhenPathsAreGated,
  showWhenPathsTo,
  subtreeDependsOnMember,
  type RenderConfig,
  type RenderAccumulators,
} from '@core/publisher'
import { buildPageFrame, buildRouteFrame, buildSiteFrame, type MemberFrame } from '@core/templates/contextFrames'
import { prefetchLoopData } from '../../publish/loopPrefetch'
import {
  sourceRequestFor,
  subtreeHasPerVisitorSource,
  visitorRequestScope,
  type LoopRequestScope,
} from '../../publish/loopSourceRequest'
import { getOrRender } from '../../publish/renderCache'
import { getPublishedNodeIndexForVersion } from '../../publish/publishedSnapshotCache'
import { getPublishVersion } from '../../publish/publishState'
import { HOLE_RUNTIME_JS, HOLE_RUNTIME_VERSION } from '../../publish/holeRuntime'
import { serveVersionedScript } from '../../publish/assetVersion'
import { stampFormPageTokens } from '../../forms/formRuntime'
import { memberAppRequestFrame } from '../../members/apps/approval'
import {
  closedContentFor,
  decideAccess,
  getAccessIndex,
  indexedRulesForPath,
  memberFrameFor,
  pageRules,
  PRIVATE_HEADERS,
  visitorFromRequest,
} from '../../publish/accessGate'

const HOLE_RUNTIME_PATH = '/_instatic/hole-runtime.js'
const HOLE_PATH_PREFIX = '/_instatic/hole/'

export function isHoleRuntimeAssetPath(pathname: string): boolean {
  return pathname === HOLE_RUNTIME_PATH
}

/**
 * GET `/_instatic/hole-runtime.js?v=<contentHash>`: cacheable under the URL
 * that names this runtime (`v` equals `HOLE_RUNTIME_VERSION`), `no-cache`
 * otherwise, `ETag` and `304` on both (see `serveVersionedScript`). A page
 * baked before a CMS upgrade carries the old hash, so it revalidates rather
 * than caching the new runtime under a URL that names the old one.
 */
export function serveHoleRuntimeAsset(req: Request, url: URL): Response {
  return serveVersionedScript(req, url, { body: HOLE_RUNTIME_JS, version: HOLE_RUNTIME_VERSION })
}

interface HoleHandlerContext {
  db: DbClient
}

// The versioned snapshot memo + nodeId → page index live in
// `publish/publishedSnapshotCache.ts`, shared with the public router and the
// loop endpoint — request-time lookup is O(1) and warm requests do zero DB I/O.

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Sorted, stable serialisation of a query string for cache keys. */
function normalizeQuery(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(entries).toString()
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
  scope: LoopRequestScope,
  closed: ClosedContent,
  /** The visitor's member frame (null when signed out); undefined for a shared render. */
  member: MemberFrame | null | undefined,
): Promise<string> {
  const route = buildRouteFrame(pageUrl.toString())
  const loopData = await prefetchLoopData(page, site, db, pageUrl, {
    requestFor: (source) => sourceRequestFor(source, scope),
    rootNodeId: nodeId,
    closed,
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
      ...(member !== undefined ? { member } : {}),
    },
    // No dynamicNodeIds: inside a hole endpoint we render the full subtree.
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
    cspSources: new Map(),
  }
  // Hole fragments bypass the published-HTML pipeline, so CMS forms inside
  // them would never receive their page token. Stamp here — tokens are
  // stateless HMAC signatures, safe to store in the Layer B fragment cache.
  return stampFormPageTokens(renderNode(nodeId, config, acc), page.id)
}

/**
 * Render a single dynamic node subtree for Layer C hole hydration.
 *
 * GET `/_instatic/hole/<nodeId>?v=<snapshotHash>&u=<page-url>` → HTML fragment.
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

  // Cache generations change on row publishes, unpublishes and deletes too.
  // Fragment validity instead follows the frozen site that produced its shell.
  const currentVersion = getPublishVersion()
  const snap = await getPublishedNodeIndexForVersion(ctx.db, currentVersion)
  if (!snap) {
    return new Response('Site not published', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (url.searchParams.get('v') !== snap.snapshotHash) {
    return new Response('<instatic-hole-stale data-instatic-stale="true"></instatic-hole-stale>', {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }
  const foundPage = snap.nodeIndex.get(nodeId)
  if (!foundPage) {
    return new Response('Node not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Reconstruct the originating page URL forwarded by the runtime (`u`). Falls
  // back to the page's own permalink when absent (older runtime / direct hit).
  const pageUrlRaw = url.searchParams.get('u') ?? buildPageFrame(foundPage).permalink
  let pageUrl: URL
  try {
    pageUrl = new URL(pageUrlRaw, url.origin)
  } catch {
    pageUrl = new URL(buildPageFrame(foundPage).permalink, url.origin)
  }

  // A fragment is part of a page and is gated like one: by the page that owns
  // the node, and (for a node in a template) by the route it is rendered on.
  // `u` is chosen by the caller, so it can only ever add a restriction.
  const accessIndex = await getAccessIndex(ctx.db, currentVersion)
  const rules = [...pageRules(accessIndex, foundPage), ...indexedRulesForPath(accessIndex, pageUrl.pathname)]
  const isProtected = rules.length > 0
  const visitor = visitorFromRequest(ctx.db, req)
  if (isProtected && (await decideAccess(rules, visitor)) !== 'allow') {
    return new Response('Node not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', ...PRIVATE_HEADERS },
    })
  }

  // Lists in the fragment leave out what the visitor may not open. Only a
  // protected page's fragment is rendered for a known member; every other
  // fragment is shared, so it is rendered as for a signed-out visitor.
  const closed = closedContentFor(accessIndex, isProtected ? ((await visitor())?.tags ?? null) : null)

  // Per-visitor when any list in the fragment uses a per-visitor source: the
  // node itself, a list nested in another list's item, or one inside a
  // Visual Component the fragment places.
  const perVisitor = subtreeHasPerVisitorSource(foundPage, snap.site, nodeId)
  // A fragment that shows member data or has a show-when rule is rendered
  // for this visitor alone, on a public page as much as on a protected one.
  // So is a fragment that sits inside an element with a show-when rule: the
  // rules above it are checked here, because rendering starts at this node.
  // A node that is not on any render path of its page is given to nobody.
  const paths = showWhenPathsTo(foundPage, snap.site, nodeId, { includeSelf: false })
  const gated = showWhenPathsAreGated(paths)
  const showsMember = gated || subtreeDependsOnMember(foundPage, snap.site, registry, nodeId)
  if (gated) {
    const who = await visitor()
    const asking = who ? (await memberAppRequestFrame(ctx.db, pageUrl)) !== null : false
    if (!showWhenPathsAllow(paths, who ? { tags: who.tags, appAsking: asking } : null)) {
      // Exactly what the page render gives this visitor for the enclosing element: nothing.
      return new Response('', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } })
    }
  }
  const route = buildRouteFrame(pageUrl.toString())
  // Parsed query params of the originating page request — handed to a
  // request-dependent loop source's `fetch()` via `ctx.request.query`.
  const query: Record<string, string> = Object.fromEntries(pageUrl.searchParams)

  const base = { query, path: route.path, slug: route.slug }

  // Per-visitor hole, any hole of a protected page, or one that depends on
  // the member: bypass Layer B entirely and never cache. Only per-visitor
  // sources get the cookies and the member, each through its own request.
  if (perVisitor || isProtected || showsMember) {
    const scope = visitorRequestScope(base, req, visitor)
    const signedIn = isProtected || showsMember ? await visitor() : undefined
    const member = signedIn === undefined
      ? undefined
      : memberFrameFor(signedIn, signedIn ? await memberAppRequestFrame(ctx.db, pageUrl) : null)
    const html = await renderHoleFragment(nodeId, foundPage, snap.site, ctx.db, pageUrl, scope, closed, member)
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...PRIVATE_HEADERS,
      },
    })
  }

  // Shared hole: cache via Layer B keyed on the originating page's PATH and
  // normalized query, so distinct requests get distinct slots while identical
  // ones single-flight. The fragment's content depends on the page URL (its
  // path drives `route.path` / `route.slug` / `route.segments`), so the path
  // MUST be part of the key. Keying on the query alone let an attacker render a
  // fragment under an arbitrary `u` path and have it served as the canonical
  // cached response for the real page (GHSA-f29g). The scope has no visitor:
  // no cookies (they would fragment the cache) and no member.
  const scope: LoopRequestScope = { base }
  const cached = await getOrRender(
    {
      urlPath: `${HOLE_PATH_PREFIX}${nodeId}`,
      queryString: `v=${currentVersion}&u=${encodeURIComponent(pageUrl.pathname)}&${normalizeQuery(pageUrl.searchParams)}`,
    },
    async () => {
      const html = await renderHoleFragment(nodeId, foundPage, snap.site, ctx.db, pageUrl, scope, closed, undefined)
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
