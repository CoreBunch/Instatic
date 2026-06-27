/**
 * SEO report — granular per-target checks plus a weighted 0–100 score,
 * computed client-side from raw target values and the resolved metadata, so
 * the target index, the preview editor, and published output agree by
 * construction (one resolver, one rule set).
 *
 * Each check carries the advice line the editor shows in its improvements
 * list; the score is the weighted pass ratio (warn earns half credit). The
 * site-wide score is the plain mean of the per-target scores.
 */

import type { SeoMetadata } from './schema'
import type { ResolvedSeoMetadata } from './resolve'
import {
  approxPixelWidth,
  meterZone,
  TITLE_PIXEL_BUDGET,
  TITLE_PIXEL_MIN,
  DESCRIPTION_PIXEL_BUDGET,
  DESCRIPTION_PIXEL_MIN,
} from './lengthMeter'

export type SeoCheckStatus = 'pass' | 'warn' | 'fail'

export type SeoCheckId =
  | 'title'
  | 'description'
  | 'socialImage'
  | 'imageAlt'
  | 'indexable'
  | 'canonical'

export interface SeoCheck {
  id: SeoCheckId
  label: string
  status: SeoCheckStatus
  /** One actionable sentence; present whenever status is not 'pass'. */
  advice?: string
  /** Relative score weight — pass earns it, warn earns half, fail none. */
  weight: number
}

export interface SeoReport {
  checks: SeoCheck[]
  /** Weighted pass ratio, 0–100. */
  score: number
  /** Count of non-pass checks, for index filtering / summary chips. */
  issueCount: number
}

export type SeoScoreTier = 'good' | 'fair' | 'poor'

export function seoScoreTier(score: number): SeoScoreTier {
  if (score >= 80) return 'good'
  if (score >= 50) return 'fair'
  return 'poor'
}

function titleCheck(resolved: ResolvedSeoMetadata): SeoCheck {
  const base = { id: 'title' as const, label: 'Title', weight: 30 }
  if (resolved.title === '') {
    return { ...base, status: 'fail', advice: 'Add one — the title is the strongest ranking signal on the page.' }
  }
  const zone = meterZone(approxPixelWidth(resolved.title), TITLE_PIXEL_BUDGET, TITLE_PIXEL_MIN)
  if (zone === 'over') {
    return { ...base, status: 'warn', advice: 'Will truncate in results — keep it under ~60 characters.' }
  }
  if (zone === 'short') {
    return { ...base, status: 'warn', advice: 'Short — 30–60 characters use the snippet space search engines give it.' }
  }
  return { ...base, status: 'pass' }
}

function descriptionCheck(resolved: ResolvedSeoMetadata): SeoCheck {
  const base = { id: 'description' as const, label: 'Description', weight: 30 }
  const description = resolved.description ?? ''
  if (description === '') {
    return { ...base, status: 'fail', advice: 'Add one — without it, search engines improvise a snippet from page content.' }
  }
  const zone = meterZone(approxPixelWidth(description), DESCRIPTION_PIXEL_BUDGET, DESCRIPTION_PIXEL_MIN)
  if (zone === 'over') {
    return { ...base, status: 'warn', advice: 'Will truncate in results — keep it under ~160 characters.' }
  }
  if (zone === 'short') {
    return { ...base, status: 'warn', advice: 'Short — 70–160 characters make a fuller snippet.' }
  }
  return { ...base, status: 'pass' }
}

export function computeSeoReport(
  target: SeoMetadata | undefined,
  resolved: ResolvedSeoMetadata,
): SeoReport {
  const checks: SeoCheck[] = [titleCheck(resolved), descriptionCheck(resolved)]

  checks.push(
    resolved.ogImage
      ? { id: 'socialImage', label: 'Social image', status: 'pass', weight: 15 }
      : {
          id: 'socialImage',
          label: 'Social image',
          status: 'fail',
          advice: 'Add one — links without an image render as bare text cards when shared.',
          weight: 15,
        },
  )

  // Alt text is only assessable once an image exists; with no image the
  // check is omitted so the missing image isn't punished twice.
  if (resolved.ogImage) {
    checks.push(
      resolved.ogImageAlt
        ? { id: 'imageAlt', label: 'Image alt text', status: 'pass', weight: 10 }
        : {
            id: 'imageAlt',
            label: 'Image alt text',
            status: 'warn',
            advice: 'Describe the social image — alt text feeds accessibility and answer engines.',
            weight: 10,
          },
    )
  }

  checks.push(
    target?.noindex === true
      ? {
          id: 'indexable',
          label: 'Indexing',
          status: 'fail',
          advice: 'noindex is set — intentional for utility pages, fatal for anything that should rank.',
          weight: 15,
        }
      : { id: 'indexable', label: 'Indexing', status: 'pass', weight: 15 },
  )

  checks.push(
    resolved.canonicalUrl
      ? { id: 'canonical', label: 'Canonical URL', status: 'pass', weight: 10 }
      : {
          id: 'canonical',
          label: 'Canonical URL',
          status: 'warn',
          advice: 'Set the public origin in Settings so a canonical URL derives automatically.',
          weight: 10,
        },
  )

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0)
  const earned = checks.reduce(
    (sum, check) =>
      sum + (check.status === 'pass' ? check.weight : check.status === 'warn' ? check.weight / 2 : 0),
    0,
  )

  return {
    checks,
    score: Math.round((earned / totalWeight) * 100),
    issueCount: checks.filter((check) => check.status !== 'pass').length,
  }
}

/** Site-wide score: plain mean of per-target scores (0 with no targets). */
export function aggregateSeoScore(reports: SeoReport[]): number {
  if (reports.length === 0) return 0
  return Math.round(reports.reduce((sum, report) => sum + report.score, 0) / reports.length)
}
