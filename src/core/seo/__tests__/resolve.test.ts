import { describe, expect, test } from 'bun:test'
import { resolveSeoMetadata, isSafeCanonicalUrl, absoluteUrl } from '../resolve'

const BASE = {
  siteName: 'Acme',
  routeKind: 'page' as const,
  routePath: '/about',
}

describe('resolveSeoMetadata — title (two-stage)', () => {
  test('explicit target title wins as-is, no pattern applied', () => {
    const resolved = resolveSeoMetadata({
      ...BASE,
      target: { title: 'Custom title' },
      siteSeo: { titlePattern: '{page.title} — {site.name}' },
      interpolate: () => 'INTERPOLATED',
    })
    expect(resolved.title).toBe('Custom title')
  })

  test('pattern interpolates when no explicit title', () => {
    const resolved = resolveSeoMetadata({
      ...BASE,
      baseTitle: 'About',
      siteSeo: { titlePattern: '{page.title} — {site.name}' },
      interpolate: (p) => p.replace('{page.title}', 'About').replace('{site.name}', 'Acme'),
    })
    expect(resolved.title).toBe('About — Acme')
  })

  test('template pattern beats site pattern', () => {
    const resolved = resolveSeoMetadata({
      ...BASE,
      templateSeo: { title: 'T:{x}' },
      siteSeo: { titlePattern: 'S:{x}' },
      interpolate: (p) => p,
    })
    expect(resolved.title).toBe('T:{x}')
  })

  test('falls back baseTitle then siteName without pattern', () => {
    expect(resolveSeoMetadata({ ...BASE, baseTitle: 'About' }).title).toBe('About')
    expect(resolveSeoMetadata(BASE).title).toBe('Acme')
  })

  test('empty-string target title is treated as unset', () => {
    expect(resolveSeoMetadata({ ...BASE, target: { title: '' }, baseTitle: 'About' }).title).toBe(
      'About',
    )
  })
})

describe('resolveSeoMetadata — description', () => {
  test('target → template(interpolated) → site default', () => {
    expect(
      resolveSeoMetadata({ ...BASE, target: { description: 'mine' }, siteSeo: { description: 'site' } })
        .description,
    ).toBe('mine')
    expect(
      resolveSeoMetadata({
        ...BASE,
        templateSeo: { description: '{currentEntry.excerpt}' },
        siteSeo: { description: 'site' },
        interpolate: () => 'from-template',
      }).description,
    ).toBe('from-template')
    expect(resolveSeoMetadata({ ...BASE, siteSeo: { description: 'site' } }).description).toBe('site')
    expect(resolveSeoMetadata(BASE).description).toBeUndefined()
  })
})

describe('resolveSeoMetadata — canonical / absolute URLs', () => {
  test('origin produces canonical and ogUrl', () => {
    const resolved = resolveSeoMetadata({ ...BASE, origin: 'https://acme.com/' })
    expect(resolved.canonicalUrl).toBe('https://acme.com/about')
    expect(resolved.ogUrl).toBe('https://acme.com/about')
  })

  test('no origin ⇒ canonical and ogUrl omitted, never guessed', () => {
    const resolved = resolveSeoMetadata(BASE)
    expect(resolved.canonicalUrl).toBeUndefined()
    expect(resolved.ogUrl).toBeUndefined()
  })

  test('explicit safe canonical wins; unsafe one is ignored', () => {
    expect(
      resolveSeoMetadata({ ...BASE, target: { canonicalUrl: 'https://other.com/x' } }).canonicalUrl,
    ).toBe('https://other.com/x')
    expect(
      resolveSeoMetadata({
        ...BASE,
        target: { canonicalUrl: 'javascript:void(0)' },
        origin: 'https://acme.com',
      }).canonicalUrl,
    ).toBe('https://acme.com/about')
  })
})

describe('resolveSeoMetadata — social fallbacks', () => {
  test('og falls back to search values, x falls back to og', () => {
    const resolved = resolveSeoMetadata({
      ...BASE,
      target: { title: 'T', description: 'D', ogImage: '/img.png', ogImageAlt: 'alt' },
    })
    expect(resolved.ogTitle).toBe('T')
    expect(resolved.ogDescription).toBe('D')
    expect(resolved.xTitle).toBe('T')
    expect(resolved.xImage).toBe('/img.png')
    expect(resolved.xImageAlt).toBe('alt')
  })

  test('xCard: explicit → site default → image-derived', () => {
    expect(resolveSeoMetadata({ ...BASE, target: { xCard: 'summary' } }).xCard).toBe('summary')
    expect(
      resolveSeoMetadata({ ...BASE, siteSeo: { defaultXCard: 'summary' }, target: { ogImage: '/i.png' } })
        .xCard,
    ).toBe('summary')
    expect(resolveSeoMetadata({ ...BASE, target: { ogImage: '/i.png' } }).xCard).toBe(
      'summary_large_image',
    )
    expect(resolveSeoMetadata(BASE).xCard).toBe('summary')
  })

  test('ogType defaults by route kind; article carries timestamps', () => {
    expect(resolveSeoMetadata(BASE).ogType).toBe('website')
    const row = resolveSeoMetadata({
      ...BASE,
      routeKind: 'row',
      publishedAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-02T00:00:00Z',
    })
    expect(row.ogType).toBe('article')
    expect(row.articlePublishedTime).toBe('2026-06-01T00:00:00Z')
    expect(row.articleModifiedTime).toBe('2026-06-02T00:00:00Z')
    // website pages carry no article times even when timestamps are present
    const page = resolveSeoMetadata({ ...BASE, publishedAt: '2026-06-01T00:00:00Z' })
    expect(page.articlePublishedTime).toBeUndefined()
  })

  test('x site handle is normalised to leading @', () => {
    expect(resolveSeoMetadata({ ...BASE, siteSeo: { xSiteHandle: 'acme' } }).xSiteHandle).toBe('@acme')
    expect(resolveSeoMetadata({ ...BASE, siteSeo: { xSiteHandle: '@acme' } }).xSiteHandle).toBe('@acme')
    expect(resolveSeoMetadata({ ...BASE, siteSeo: { xSiteHandle: '' } }).xSiteHandle).toBeUndefined()
  })
})

describe('resolveSeoMetadata — locale + noindex', () => {
  test('og:locale derives from language', () => {
    expect(resolveSeoMetadata({ ...BASE, language: 'en' }).ogLocale).toBe('en')
    expect(resolveSeoMetadata({ ...BASE, language: 'en-US' }).ogLocale).toBe('en_US')
    expect(resolveSeoMetadata(BASE).ogLocale).toBeUndefined()
  })

  test('noindex flag carries through', () => {
    expect(resolveSeoMetadata({ ...BASE, target: { noindex: true } }).noindex).toBe(true)
    expect(resolveSeoMetadata(BASE).noindex).toBe(false)
  })
})

describe('url helpers', () => {
  test('isSafeCanonicalUrl', () => {
    expect(isSafeCanonicalUrl('https://a.com/x')).toBe(true)
    expect(isSafeCanonicalUrl('http://a.com')).toBe(true)
    expect(isSafeCanonicalUrl('javascript:void(0)')).toBe(false)
    expect(isSafeCanonicalUrl('/relative')).toBe(false)
  })

  test('absoluteUrl joins without double slashes', () => {
    expect(absoluteUrl('https://a.com/', '/x')).toBe('https://a.com/x')
    expect(absoluteUrl('https://a.com', 'x')).toBe('https://a.com/x')
  })
})
