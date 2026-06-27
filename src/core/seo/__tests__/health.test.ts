import { describe, expect, test } from 'bun:test'
import { computeSeoReport, aggregateSeoScore, seoScoreTier } from '../health'
import { resolveSeoMetadata } from '../resolve'
import {
  approxPixelWidth,
  meterZone,
  TITLE_PIXEL_BUDGET,
  TITLE_PIXEL_MIN,
} from '../lengthMeter'

const BASE = {
  siteName: 'Acme',
  routeKind: 'page' as const,
  routePath: '/about',
  origin: 'https://acme.com',
}

function check(report: ReturnType<typeof computeSeoReport>, id: string) {
  return report.checks.find((c) => c.id === id)!
}

describe('computeSeoReport', () => {
  test('fully optimized target scores 100 with zero issues', () => {
    const target = {
      title: 'A descriptive title in the ideal band',
      description:
        'A reasonably detailed description for the page that lands inside the ideal length band for snippets.',
      ogImage: '/img.png',
      ogImageAlt: 'An image',
    }
    const report = computeSeoReport(target, resolveSeoMetadata({ ...BASE, target }))
    expect(report.score).toBe(100)
    expect(report.issueCount).toBe(0)
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true)
  })

  test('flags missing description, missing alt, and noindex', () => {
    const target = { title: 'A descriptive title in the ideal band', noindex: true, ogImage: '/img.png' }
    const report = computeSeoReport(target, resolveSeoMetadata({ ...BASE, target }))
    expect(check(report, 'description').status).toBe('fail')
    expect(check(report, 'imageAlt').status).toBe('warn')
    expect(check(report, 'indexable').status).toBe('fail')
    expect(report.issueCount).toBe(3)
    expect(report.score).toBeLessThan(60)
  })

  test('short title warns instead of passing — green only in the ideal band', () => {
    expect(meterZone(approxPixelWidth('Home'), TITLE_PIXEL_BUDGET, TITLE_PIXEL_MIN)).toBe('short')
    const target = { title: 'Home' }
    const report = computeSeoReport(target, resolveSeoMetadata({ ...BASE, target }))
    expect(check(report, 'title').status).toBe('warn')
    expect(check(report, 'title').advice).toContain('Short')
  })

  test('over-budget title warns about truncation', () => {
    const longTitle = 'Wide MMMM Words '.repeat(8)
    expect(meterZone(approxPixelWidth(longTitle), TITLE_PIXEL_BUDGET, TITLE_PIXEL_MIN)).toBe('over')
    const target = { title: longTitle }
    const report = computeSeoReport(target, resolveSeoMetadata({ ...BASE, target }))
    expect(check(report, 'title').status).toBe('warn')
    expect(check(report, 'title').advice).toContain('truncate')
  })

  test('alt check is omitted when there is no social image', () => {
    const target = { title: 'A descriptive title in the ideal band' }
    const report = computeSeoReport(target, resolveSeoMetadata({ ...BASE, target }))
    expect(check(report, 'socialImage').status).toBe('fail')
    expect(report.checks.some((c) => c.id === 'imageAlt')).toBe(false)
  })

  test('missing public origin downgrades the canonical check to warn', () => {
    const target = { title: 'A descriptive title in the ideal band' }
    const report = computeSeoReport(
      target,
      resolveSeoMetadata({ siteName: 'Acme', routeKind: 'page', routePath: '/about', target }),
    )
    expect(check(report, 'canonical').status).toBe('warn')
  })
})

describe('aggregateSeoScore / seoScoreTier', () => {
  test('aggregates the mean and maps tiers', () => {
    expect(aggregateSeoScore([])).toBe(0)
    expect(aggregateSeoScore([{ checks: [], score: 100, issueCount: 0 }, { checks: [], score: 50, issueCount: 1 }])).toBe(75)
    expect(seoScoreTier(92)).toBe('good')
    expect(seoScoreTier(64)).toBe('fair')
    expect(seoScoreTier(31)).toBe('poor')
  })
})
