import type { DbClient } from '../db/client'
import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import { resolveNotFoundTemplate } from '@core/templates'
import { assertLoopRenderScopes, collectLoopRenderScopes } from '@core/publisher'
import { resolvePublicRoute, resolvePublishedNotFoundRoute } from './publicRouteResolution'
import { buildPublishedEntryRenderContext, buildPublishedPageRenderContext } from './publishedRenderContext'
import { NOT_FOUND_ARTEFACT_URL_PATH } from './staticArtefact'
import type { PublishedPageSnapshot } from '../repositories/publish'
import type { PublishedRenderContext } from './publishedRenderContext'

export class LoopFragmentContextError extends Error {
  readonly status: 400 | 404 | 409

  constructor(message: string, status: 400 | 404 | 409) {
    super(message)
    this.name = 'LoopFragmentContextError'
    this.status = status
  }
}

/** Require the actual local public URL; never recover an arbitrary consumer by node ID. */
export function readLoopPageUrl(pagePath: string, endpointUrl: URL): URL {
  if (!pagePath.startsWith('/') || pagePath.startsWith('//')) {
    throw new LoopFragmentContextError('The originating page URL must be a local absolute path', 400)
  }
  let pageUrl: URL
  try {
    pageUrl = new URL(pagePath, endpointUrl.origin)
  } catch {
    throw new LoopFragmentContextError('Invalid originating page URL', 400)
  }
  if (pageUrl.origin !== endpointUrl.origin || pageUrl.hash) {
    throw new LoopFragmentContextError('Invalid originating page URL', 400)
  }
  try {
    decodeURIComponent(pageUrl.pathname)
  } catch {
    throw new LoopFragmentContextError('Invalid originating page URL', 400)
  }
  return pageUrl
}

function findLoopTarget(page: Page, site: SiteDocument, loopId: string) {
  const scopes = collectLoopRenderScopes(page, site)
  const targets = scopes.filter((scope) => scope.node.id === loopId)
  if (targets.length === 0) throw new LoopFragmentContextError('Loop not found on the published page', 404)
  assertLoopRenderScopes(page, scopes)
  if (targets.length > 1) throw new LoopFragmentContextError('Loop has multiple instances on the published page', 409)
  const target = targets[0]
  const nodes: Record<string, PageNode> = {}
  for (const [id, current] of Object.entries(target.nodes)) nodes[id] = { ...current }
  reindexNodeParents(nodes)
  return { node: target.node, page: { ...page, nodes, rootNodeId: target.node.id } }
}

/** Resolve the same published page/entry/404 and template composition as the full public renderer. */
export async function resolveLoopFragmentContext(db: DbClient, pageUrl: URL, loopId: string) {
  const resolution = await resolvePublicRoute(db, pageUrl)
  if (resolution.kind === 'redirect') {
    throw new LoopFragmentContextError('The originating page has moved', 409)
  }
  let snapshot: PublishedPageSnapshot | null
  let context: PublishedRenderContext | null
  if (resolution.kind === 'not-found') {
    snapshot = await resolvePublishedNotFoundRoute(db)
    const page = snapshot && resolveNotFoundTemplate(snapshot.site)
    if (!snapshot || !page) throw new LoopFragmentContextError('Published page not found', 404)
    pageUrl = new URL(NOT_FOUND_ARTEFACT_URL_PATH, pageUrl.origin)
    context = buildPublishedPageRenderContext(snapshot, page, pageUrl)
  } else {
    snapshot = resolution.snapshot
    if (resolution.kind === 'row') {
      context = buildPublishedEntryRenderContext(snapshot, resolution.row, pageUrl)
    } else {
      const pageId = snapshot.pageRowId
      const page = snapshot.site.pages.find((candidate) => candidate.id === pageId)
      if (!page) throw new LoopFragmentContextError('Published page not found', 404)
      context = buildPublishedPageRenderContext(snapshot, page, pageUrl)
    }
    if (!context) throw new LoopFragmentContextError('Published entry template not found', 404)
  }
  const target = findLoopTarget(context.page, snapshot.site, loopId)
  return { ...target, site: snapshot.site, templateContext: context.templateContext, pageUrl }
}
