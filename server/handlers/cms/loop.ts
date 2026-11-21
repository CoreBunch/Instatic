/**
 * `/_instatic/loop/<loopId>` endpoint — serves additional pages for
 * infinite-loading loops.
 *
 * Called by the loop runtime (`loopRuntime.ts`) after the user clicks
 * "Load more". Returns `{ html, hasMore, pageNumber }` JSON.
 *
 * Algorithm:
 *   1. Resolve the page from the request's `pagePath` query param via
 *      the same routing logic the public renderer uses.
 *   2. Find the loop node by id within the resolved page.
 *   3. Run the loop's source `fetch()` for the requested page slice.
 *   4. Render only the loop's children using a synthetic page context
 *      sharing the publisher's renderNode walker.
 *   5. Return the joined HTML — clients append it before the load-more
 *      button.
 *
 * This handler is GET-only and returns 404 for any combination that
 * doesn't resolve cleanly. Errors are rendered as 4xx/5xx with empty
 * bodies; the runtime's "Try again" UX surfaces network failures.
 */

import type { DbClient } from '../../db/client'
import { registry } from '@core/module-engine'
import { loopSourceRegistry } from '@core/loops/registry'
import { resolveLoopDirection } from '@core/loops'
import {
  renderNode,
  showWhenPathsAllow,
  showWhenPathsAreGated,
  showWhenPathsTo,
  subtreeDependsOnMember,
  type RenderConfig,
  type RenderAccumulators,
  type ResolvedLoopRenderData,
} from '@core/publisher'
import { jsonResponse } from '../../http'
import { isComposedNodeId } from '@core/templates'
import { memberAppRequestFrame } from '../../members/apps/approval'
import { composedRouteForPath } from '../../publish/composedRoute'
import { buildPageFrame, buildRouteFrame, buildSiteFrame } from '@core/templates/contextFrames'
import { collectLoopNodes, readLoopProps } from '../../publish/loopPrefetch'
import { sourceRequestFor, visitorRequestScope } from '../../publish/loopSourceRequest'
import { getPublishedLoopIndexForVersion } from '../../publish/publishedSnapshotCache'
import { getPublishVersion } from '../../publish/publishState'
import { LOOP_RUNTIME_JS, LOOP_RUNTIME_VERSION } from '../../publish/loopRuntime'
import { serveVersionedScript } from '../../publish/assetVersion'
import {
  closedContentFor,
  decideAccess,
  getAccessIndex,
  memberFrameFor,
  indexedRulesForPath,
  pageRules,
  PRIVATE_HEADERS,
  visitorFromRequest,
} from '../../publish/accessGate'

const LOOP_RUNTIME_PATH = '/_instatic/assets/loop-runtime.js'

export function isLoopRuntimeAssetPath(pathname: string): boolean {
  return pathname === LOOP_RUNTIME_PATH
}

/**
 * GET `/_instatic/assets/loop-runtime.js?v=<contentHash>`: cacheable under the
 * URL that names this runtime, `no-cache` otherwise, `ETag` and `304` on both
 * (see `serveVersionedScript`).
 */
export function serveLoopRuntimeAsset(req: Request, url: URL): Response {
  return serveVersionedScript(req, url, { body: LOOP_RUNTIME_JS, version: LOOP_RUNTIME_VERSION })
}

interface LoopHandlerContext {
  db: DbClient
}

export async function handleLoopRequest(
  req: Request,
  url: URL,
  ctx: LoopHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  // /_instatic/loop/<encoded-loopId>
  const loopId = decodeURIComponent(url.pathname.slice('/_instatic/loop/'.length))
  if (!loopId) return jsonResponse({ error: 'Missing loop id' }, { status: 400 })

  const pageNumberRaw = url.searchParams.get('page') ?? '1'
  const pageNumber = Math.max(1, Number.parseInt(pageNumberRaw, 10) || 1)

  const version = getPublishVersion()
  const loopIndex = await getPublishedLoopIndexForVersion(ctx.db, version)
  if (!loopIndex) return jsonResponse({ error: 'Site not published' }, { status: 404 })
  const { site } = loopIndex
  const indexed = loopIndex.loops.get(loopId)
  const fallback = indexed ? buildPageFrame(indexed.page).permalink : '/'
  const pagePath = url.searchParams.get('pagePath')
  let pageUrl: URL
  try {
    pageUrl = new URL(pagePath ?? fallback, url.origin)
    if (pageUrl.origin !== url.origin) return jsonResponse({ error: 'Invalid page path' }, { status: 400 })
  } catch {
    return jsonResponse({ error: 'Invalid page path' }, { status: 400 })
  }

  // Standalone lists use the published index. Layout outlets and their
  // descendants must use the same composed tree as the initial page.
  const useRoute = isComposedNodeId(loopId) || (pagePath !== null && loopIndex.hasTemplates)
  const composed = useRoute ? await composedRouteForPath(ctx.db, pageUrl, site) : null
  const containingPage = useRoute ? composed?.page : indexed?.page
  const loopNode = useRoute
    ? composed && collectLoopNodes(composed.page, site).find((node) => node.id === loopId)
    : indexed?.node
  if (!containingPage || !loopNode) return jsonResponse({ error: 'Loop not found' }, { status: 404 })

  const accessIndex = await getAccessIndex(ctx.db, version)
  const rules = [...pageRules(accessIndex, containingPage), ...indexedRulesForPath(accessIndex, pageUrl.pathname)]
  const isProtected = rules.length > 0
  const visitor = visitorFromRequest(ctx.db, req)
  if (isProtected && (await decideAccess(rules, visitor)) !== 'allow') {
    return jsonResponse({ error: 'Loop not found' }, { status: 404, headers: PRIVATE_HEADERS })
  }
  // The list leaves out what the visitor may not open (see `closedContentFor`).
  const closed = closedContentFor(accessIndex, isProtected ? ((await visitor())?.tags ?? null) : null)
  // Items that show member data are rendered for this visitor alone.
  // The items are rendered here without the loop element itself, so its own
  // show-when rule and those of everything around it are checked here.
  // The loop may live inside a Visual Component, so the rules are followed
  // along the render path, through the component and the reference that
  // placed it. A loop on no render path is given to nobody.
  const paths = showWhenPathsTo(containingPage, site, loopNode.id, { includeSelf: true, composed: composed !== null })
  const gated = showWhenPathsAreGated(paths)
  // A loop inside a component is not in the page's own node map, where
  // `subtreeDependsOnMember` looks; treat it as per-visitor rather than guess.
  const inComponent = containingPage.nodes[loopNode.id] === undefined
  const showsMember = gated || inComponent || subtreeDependsOnMember(containingPage, site, registry, loopNode.id)
  const forVisitor = isProtected || showsMember
  const who = forVisitor ? await visitor() : null
  const appRequest = who ? await memberAppRequestFrame(ctx.db, pageUrl) : null
  if (gated) {
    if (!showWhenPathsAllow(paths, who ? { tags: who.tags, appAsking: appRequest !== null } : null)) {
      return jsonResponse({ html: '', hasMore: false, pageNumber }, { headers: PRIVATE_HEADERS })
    }
  }

  const props = readLoopProps(loopNode)
  if (props.pagination !== 'infinite') {
    return jsonResponse({ error: 'Loop is not in infinite mode' }, { status: 400 })
  }
  const source = loopSourceRegistry.get(props.sourceId)
  if (!source) {
    return jsonResponse({ error: 'Source not registered' }, { status: 404 })
  }
  if (source.kind === 'contextual') {
    return jsonResponse({ error: 'Contextual loops do not support infinite pagination' }, { status: 400 })
  }
  // A remote descriptor exists only in the editor; the server holds the real source.
  if (source.kind === 'remote') {
    return jsonResponse({ error: 'Source not registered' }, { status: 404 })
  }

  // Fetch the requested page slice.
  // Carry the original route and query to request-dependent sources. Only
  // per-visitor sources receive visitor state, as on the first page.
  const perVisitor = source.perVisitor === true
  const route = buildRouteFrame(pageUrl.toString())
  const base = { query: Object.fromEntries(pageUrl.searchParams), path: route.path, slug: route.slug }
  const request = perVisitor || source.requestDependent
    ? await sourceRequestFor(source, visitorRequestScope(base, req, visitor))
    : undefined

  const offset = props.offset + (pageNumber - 1) * props.pageSize
  let result
  try {
    result = await source.fetch({
      db: ctx.db,
      site,
      filters: props.filters,
      orderBy: props.orderBy || (source.orderByOptions[0]?.id ?? ''),
      direction: resolveLoopDirection(props.direction, source),
      limit: props.pageSize,
      offset,
      closed,
      request,
    })
  } catch (err) {
    console.error(`[loop] source "${source.id}" failed for "${loopId}":`, err)
    return jsonResponse({ error: 'Source fetch failed' }, { status: 500 })
  }

  const consumed = offset + result.items.length
  const hasMore = consumed < result.totalItems

  // Render just the loop's children for the new items. We re-use the
  // publisher's renderNode walker by constructing a synthetic context;
  // CSS dedup is a no-op here because the asset bundle is already
  // loaded on the client.
  const variants = loopNode.children
  // A per-visitor source answers for this visitor alone, whatever its items
  // render: the response must never be stored or shared.
  const headers = forVisitor || perVisitor ? { headers: PRIVATE_HEADERS } : {}
  if (variants.length === 0) {
    return jsonResponse({ html: '', hasMore, pageNumber }, headers)
  }
  const baseConfig: RenderConfig = {
    page: containingPage,
    site,
    registry,
    breakpointId: undefined,
    templateContext: {
      entryStack: composed?.entryStack ?? [], page: buildPageFrame(containingPage), site: buildSiteFrame(site), route,
      ...(forVisitor ? { member: memberFrameFor(who, appRequest) } : {}),
    },
    loopData: new Map<string, ResolvedLoopRenderData>([
      [loopId, { items: result.items, totalItems: result.totalItems, pageNumber, hasMore }],
    ]),
  }
  const acc: RenderAccumulators = {
    cssMap: new Map(),
    jsMap: new Map(),
    infiniteLoopIds: new Set(),
    holeNodeIds: new Set(),
    cspSources: new Map(),
  }

  // Render each item by walking each variant child once per iteration.
  // Bypass renderLoop so we don't re-emit the wrapper element — the
  // existing wrapper on the client absorbs the appended fragments. Each
  // iteration derives a fresh config with a new entryStack snapshot rather
  // than mutating a shared array in place.
  let html = ''
  result.items.forEach((item, i) => {
    const variantId = variants[i % variants.length]
    const iterationConfig: RenderConfig = {
      ...baseConfig,
      // Spread the base templateContext so any page/site/route frames survive —
      // mirrors renderLoop.ts.
      templateContext: { ...baseConfig.templateContext, entryStack: [...(composed?.entryStack ?? []), item] },
    }
    html += renderNode(variantId, iterationConfig, acc)
  })

  return jsonResponse({ html, hasMore, pageNumber }, headers)
}
