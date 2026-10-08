/**
 * Render-time data context shared by structured dynamic bindings and inline
 * token interpolation.
 */

import type { LoopItem } from '@core/loops-schema'
import type { Page, SiteDocument } from '@core/page-tree'
import { buildPageFrame, buildSiteFrame, buildRouteFrame } from './contextFrames'
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
}

/**
 * Seed the page/site/route frames a caller may have omitted from its
 * TemplateRenderDataContext. Every published page needs all four frames
 * populated so dynamic bindings against those sources resolve — even on
 * plain (non-template, non-loop) pages. Caller-provided values always
 * win; missing slots fall back to defaults derived from the page/site.
 */
export function buildTemplateRenderContext(
  page: Page,
  site: SiteDocument,
  incoming: TemplateRenderDataContext | undefined,
): TemplateRenderDataContext {
  const provided = incoming ?? { entryStack: [] }
  const pageFrame = provided.page ?? buildPageFrame(page)
  const siteFrame = buildSiteFrame(site, pageFrame.language)
  return {
    entryStack: provided.entryStack,
    page: pageFrame,
    site: { ...siteFrame, ...provided.site, language: siteFrame.language, translations: siteFrame.translations },
    route: provided.route ?? buildRouteFrame(pageFrame.permalink),
  }
}
