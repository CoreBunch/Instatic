/**
 * Before/after page renders for the merge review — one page, from main's
 * draft or the branch's draft, as HTML for a sandboxed iframe.
 *
 * Composed the way the branch preview composes a page (template chain,
 * draft loops, inlined CSS), with two differences: every node's root
 * element carries `uid="<nodeId>"`, so the review can outline the nodes
 * the plan says changed, and no runtime scripts are bundled — the frame
 * is sandboxed without scripts, so bundling would be wasted work.
 */
import '../../src/modules/base'
import '@core/loops/sources'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { composeTemplateChain, resolveTemplateChain } from '@core/templates'
import { buildRouteFrame } from '@core/templates/contextFrames'
import type { SourceRequestContext } from '@core/loops/types'
import type { DbClient } from '../db/client'
import { MAIN_SCOPE, type BranchScope } from '../branches/scope'
import { getDraftSiteDocument } from '../repositories/publish'
import { prefetchLoopData } from './loopPrefetch'
import { prefetchMediaAssets } from './mediaPrefetch'
import { getPublishVersion } from './publishState'

export type ReviewRenderSide = 'main' | 'branch'

/**
 * HTML of the page row `rowId` as `side` holds it, or null when that side
 * has no such page (a page only the branch created has no main render).
 */
export async function renderBranchReviewPage(
  db: DbClient,
  branchId: string,
  side: ReviewRenderSide,
  rowId: string,
): Promise<string | null> {
  const scope: BranchScope = side === 'main' ? MAIN_SCOPE : { branchId }
  const site = await getDraftSiteDocument(db, scope)
  if (!site) return null
  const page = site.pages.find((candidate) => candidate.id === rowId)
  if (!page) return null

  const chain = resolveTemplateChain(site, { kind: 'page' })
  const merged = composeTemplateChain(chain, { kind: 'page', page })
  const url = new URL(`http://localhost/${page.slug}`)
  const templateContext = { entryStack: [], route: buildRouteFrame(url.toString()) }
  const request: SourceRequestContext = {
    query: {},
    path: url.pathname,
    slug: page.slug || null,
    cookies: {},
  }
  const loopData = await prefetchLoopData(merged, site, db, url, { branchId: scope.branchId, request })
  const mediaAssets = await prefetchMediaAssets(merged, site, registry, db, { templateContext, loopData })
  const rendered = publishPage(merged, site, registry, {
    templateContext,
    loopData,
    mediaAssets,
    dynamicNodes: 'inline',
    annotateNodeIds: true,
    publishVersion: getPublishVersion(),
  })
  return rendered.html
}
