/**
 * `/_instatic/gate/<nodeId>` endpoint — Layer C auth-gated server island.
 *
 * A `base.container` whose `authGate` prop is a non-empty group-id list
 * (Phase 3 / D16) publishes as an `<instatic-gated>` placeholder carrying
 * the module's `staticPlaceholder` fallback + the required group list. The
 * gate runtime lazy-fetches this endpoint; it renders the FULL subtree only
 * for visitors whose session is a member of at least one of the required
 * groups and returns the baked fallback for everyone else.
 *
 * Mirrors `server/handlers/cms/hole.ts` closely — same snapshot lookup, same
 * version check, same fragment renderer (`renderHoleFragment`). Differences:
 *
 *   - Reads the visitor session cookie via `gateHelpers.checkGateAccess`.
 *   - Determines `requiredGroups` from `node.props.authGate` (an array of
 *     group ids; an empty/missing array defaults to no gate — fail-open so a
 *     stale published node with the old role-string shape is treated as
 *     not-gated rather than locking out everyone).
 *   - UNAUTHORISED → returns the sanitised `staticPlaceholder` fallback (the
 *     same string baked into the placeholder). Never renders the subtree.
 *   - Always `Cache-Control: no-store` — the response is per-visitor, so it
 *     can never be shared-cached (unlike shared holes that go through Layer B).
 *
 * Version-awareness matches hole.ts: a `?v=` mismatch returns the same stale
 * sentinel so the next page load picks up the new version.
 */

import type { DbClient } from '../../db/client'
import type { PageNode } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { sanitizeRichtext } from '@core/sanitize'
import { buildPageFrame, buildRouteFrame } from '@core/templates/contextFrames'
import { renderHoleFragment } from './hole'
import { findPageForNodeId, getPublishedNodeIndexForVersion } from '../../publish/publishedSnapshotCache'
import { getPublishVersion } from '../../publish/publishState'
import { checkGateAccess } from '../../visitor-auth/gateHelpers'

export const GATE_PATH_PREFIX = '/_instatic/gate/'

interface GateHandlerContext {
  db: DbClient
}

/**
 * Render a single auth-gated node subtree for Layer C gate hydration.
 *
 * GET `/_instatic/gate/<nodeId>?v=<publishVersion>&u=<page-url>` → HTML fragment.
 */
export async function handleGateRequest(
  req: Request,
  url: URL,
  ctx: GateHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  const nodeId = decodeURIComponent(url.pathname.slice(GATE_PATH_PREFIX.length))
  if (!nodeId) {
    return new Response('Missing node id', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Version check — identical to hole.ts. A mismatch returns the lightweight
  // stale sentinel so the next full page load (carrying the new version)
  // hydrates cleanly.
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
  const found = findPageForNodeId(snap, nodeId)
  if (!found) {
    return new Response('Node not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  // Template composition prefixes node ids (c0_/t<N>_) on wrapped pages;
  // use the effective (non-composed) id for node lookup + rendering.
  const foundPage = found.page
  const effectiveNodeId = found.effectiveNodeId
  const node: PageNode | undefined = foundPage.nodes[effectiveNodeId]
  if (!node) {
    return new Response('Node not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Resolve the required groups off the published node. The dynamic-detection
  // rule only routes here when the prop is a non-empty group-id array, so a
  // missing/non-array prop on the published node implies a stale shape
  // (the Phase-2 role-string value) — treat it as not-gated (fail-open) so a
  // half-migrated publish doesn't lock out every visitor.
  const requiredGroups = Array.isArray(node.props.authGate)
    ? node.props.authGate.filter((g): g is string => typeof g === 'string')
    : []

  // Authorisation decision — single source of truth lives in gateHelpers.
  const auth = await checkGateAccess(ctx.db, req, requiredGroups)

  // Reconstruct the originating page URL forwarded by the runtime (`u`). Falls
  // back to the page's own permalink when absent (older runtime / direct hit).
  const pageUrlRaw = url.searchParams.get('u') ?? buildPageFrame(foundPage).permalink
  let pageUrl: URL
  try {
    pageUrl = new URL(pageUrlRaw, url.origin)
  } catch {
    pageUrl = new URL(buildPageFrame(foundPage).permalink, url.origin)
  }

  // Resolve the request-time route frame (path / slug / query) off the
  // originating page URL — same construction hole.ts uses so any
  // `route.query.*` / `route.slug` bindings inside the gated subtree resolve.
  const route = buildRouteFrame(pageUrl.toString())

  // UNAUTHORISED — bake the fallback. This is the SAME string the placeholder
  // carries at publish time (the module's `staticPlaceholder`, sanitised), so
  // the swap is a no-op visually for unauthorised visitors with JS, and the
  // no-JS path already shows it. Never render the gated subtree.
  if (!auth.authorized) {
    const def = registry.get(node.moduleId)
    const rawFallback = def?.staticPlaceholder?.(node.props as never) ?? ''
    const fallback = rawFallback ? sanitizeRichtext(rawFallback) : ''
    return new Response(fallback, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  // AUTHORISED — render the full subtree at request time via the shared
  // fragment renderer (same path holes use). The visitor's query string seeds
  // the route frame so any `route.query.*` bindings inside the gated subtree
  // resolve; cookies are intentionally empty for the shared render path
  // (mirrors hole.ts's shared-hole contract — gated subtrees render the SAME
  // fragment for every authorised visitor of a role, so no per-visitor data
  // leaks between caches).
  const query: Record<string, string> = Object.fromEntries(pageUrl.searchParams)
  const html = await renderHoleFragment(effectiveNodeId, foundPage, snap.site, ctx.db, pageUrl, {
    query,
    path: route.path,
    slug: route.slug,
    cookies: {},
  })

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
