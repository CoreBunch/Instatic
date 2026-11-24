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
import { REVIEW_VIEWPORT } from '@core/branches'
import '../../src/modules/base'
import '@core/loops/sources'
import type { Page, SiteDocument } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { buildPageFrame, buildRouteFrame, composeTemplateChain, resolveTemplateChain, treeHasOutlet } from '@core/templates'
import { sourceRequestFor, type LoopRequestScope } from './loopSourceRequest'
import type { DbClient } from '../db/client'
import { MAIN_SCOPE, type BranchScope } from '../branches/scope'
import { getDraftSiteDocument } from '../repositories/publish'
import { resolveViewportUnitsInHtml } from '@core/utils/viewportUnits'
import { prefetchLoopData } from './loopPrefetch'
import { prefetchMediaAssets } from './mediaPrefetch'

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
  viewport: { width: number; height: number } = REVIEW_VIEWPORT,
): Promise<string | null> {
  const scope: BranchScope = side === 'main' ? MAIN_SCOPE : { branchId }
  const site = await getDraftSiteDocument(db, scope)
  if (!site) return null
  const page = site.pages.find((candidate) => candidate.id === rowId)
  if (!page) return null

  return renderReviewDocument(db, scope, site, page, composeReviewPage(site, page).composed, viewport)
}

export function composeReviewPage(site: SiteDocument, page: Page) {
  const chain = resolveTemplateChain(site, { kind: 'page' })
  return { composed: composeTemplateChain(chain, { kind: 'page', page }), templated: chain.some(treeHasOutlet) }
}

export async function renderReviewDocument(
  db: DbClient, scope: BranchScope, site: SiteDocument, page: Page, merged: Page,
  viewport: { width: number; height: number },
) {
  const url = new URL(`http://localhost/${page.slug}`)
  const templateContext = { entryStack: [], page: buildPageFrame(page), route: buildRouteFrame(url.toString()) }
  const requestScope: LoopRequestScope = { base: { query: {}, path: url.pathname, slug: page.slug || null } }
  // Both sides read DRAFT rows: a merge compares main's draft with the
  // branch's draft, and main's published versions are what visitors see,
  // not what the merge would write over.
  const loopData = await prefetchLoopData(merged, site, db, url, {
    branchId: scope.branchId,
    requestFor: (source) => sourceRequestFor(source, requestScope),
    drafts: true,
  })
  const mediaAssets = await prefetchMediaAssets(merged, site, registry, db, { templateContext, loopData })
  const rendered = publishPage(merged, site, registry, {
    templateContext,
    loopData,
    mediaAssets,
    dynamicNodes: 'inline',
    annotateNodeIds: true,
  })
  // Viewport units against a desktop screen, not against the document-tall
  // frame: the same scanner the canvas frames use.
  return resolveViewportUnitsInHtml(rendered.html, viewport)
}
