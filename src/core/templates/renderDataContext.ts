/**
 * Render-time data context shared by structured dynamic bindings and inline
 * token interpolation.
 */

import type { LoopItem } from '@core/loops-schema'
import type { Page, SiteDocument } from '@core/page-tree'
import { buildPageFrame, buildSiteFrame, buildRouteFrame } from './contextFrames'
import { buildPublicFileReferences, type PublicFileReferences } from '@core/files/references'
import type {
  PageFrame,
  RouteFrame,
  SiteFrame,
} from './contextFrames'

/**
 * Render-time context handed to the publisher.
 *
 * `entryStack` is an immutable snapshot for the current frame. Stack-top
 * resolves `currentEntry`; one below resolves `parentEntry`. The named frames
 * are built by the publisher and referenced by their matching binding sources.
 */
export interface TemplateRenderDataContext {
  readonly entryStack: readonly LoopItem[]
  readonly page?: PageFrame
  readonly site?: SiteFrame
  readonly route?: RouteFrame
  readonly files?: PublicFileReferences
}

/**
 * Seed the page/site/route frames a caller may have omitted from its
 * TemplateRenderDataContext. Every published page needs all four frames
 * populated so dynamic bindings against those sources resolve — even on
 * plain (non-template, non-loop) pages. Derived language catalogues and page
 * relationships remain authoritative when a caller provides other frames.
 */
export function buildTemplateRenderContext(
  page: Page,
  site: SiteDocument,
  incoming: TemplateRenderDataContext | undefined,
): TemplateRenderDataContext {
  const provided = incoming ?? { entryStack: [] }
  // A composed tree belongs to its terminal page even when its root/identity
  // comes from a layout. Resolve relationships from that published page.
  const framePage = provided.page
    ? site.pages.find((candidate) => candidate.id === provided.page?.id) ?? page
    : page
  const nativePageFrame = buildPageFrame(framePage, site)
  const pageFrame = { ...nativePageFrame, ...provided.page, translations: nativePageFrame.translations }
  const siteFrame = buildSiteFrame(site, pageFrame.language)
  return {
    entryStack: provided.entryStack,
    page: pageFrame,
    site: { ...siteFrame, ...provided.site, language: siteFrame.language, translations: siteFrame.translations },
    route: provided.route ?? buildRouteFrame(pageFrame.permalink),
    files: provided.files ?? buildPublicFileReferences(site.files),
  }
}
