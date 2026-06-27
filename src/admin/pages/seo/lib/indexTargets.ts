/**
 * indexSeoTargets — pair every workspace target with its computed SEO
 * report. The Meta tab computes this once per render and shares it between
 * the scoreboard, the target index, and the issues filter so all three
 * agree on what counts as an issue.
 */
import { computeSeoReport, type SeoReport } from '@core/seo'
import type { SeoTarget } from './seoApi'
import { resolveTargetSeo, type ResolveTargetSeoContext } from './resolveTargetSeo'

export interface IndexedSeoTarget {
  target: SeoTarget
  report: SeoReport
}

export function indexSeoTargets(
  targets: SeoTarget[],
  ctx: ResolveTargetSeoContext,
): IndexedSeoTarget[] {
  return targets.map((target) => ({
    target,
    report: computeSeoReport(target.seo ?? undefined, resolveTargetSeo(target, undefined, ctx)),
  }))
}
