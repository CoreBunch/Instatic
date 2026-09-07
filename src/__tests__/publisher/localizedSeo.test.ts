import { normalizePublicOrigin } from '@core/localization-routing'
import { describe, expect, it } from 'bun:test'
import type { Locale } from '@core/localization-schema'
import { createPublishedRouteInventory, type PublishedRouteCandidate } from '@core/localization-routing'
import {
  buildLocalizedSeo,
  buildLocalizedSitemap,
  renderLocalizedSeoLinks,
} from '../../../server/publish/localizedSeo'

const de: Locale = { id: 'de', code: 'de', name: 'Deutsch', pathPrefix: '', isDefault: true, enabled: true, direction: 'ltr' }
const en: Locale = { id: 'en', code: 'en-GB', name: 'English', pathPrefix: 'en', isDefault: false, enabled: true, direction: 'ltr' }
const ar: Locale = { id: 'ar', code: 'ar', name: 'العربية', pathPrefix: 'ar', isDefault: false, enabled: true, direction: 'rtl' }

function candidate(locale: Locale, path: string, availability: 'online' | 'offline' = 'online'): PublishedRouteCandidate {
  return {
    contentId: 'about', localeId: locale.id, publishedVersionId: `v-${locale.id}`,
    tableId: 'pages', tableSlug: 'pages', kind: 'page', path, availability,
    publishedAt: '2026-09-07T12:00:00.000Z',
  }
}

describe('published localization SEO', () => {
  it('emits self-canonicals and identical reciprocal hreflang sets for all online variants', () => {
    const inventory = createPublishedRouteInventory([de, en, ar], [
      candidate(de, '/ueber-uns'), candidate(en, '/en/about'), candidate(ar, '/ar/about', 'offline'),
    ])
    const german = buildLocalizedSeo(inventory, inventory.routes[0], 'https://example.test')!
    const english = buildLocalizedSeo(inventory, inventory.routes[1], 'https://example.test')!
    expect(german.canonicalUrl).toBe('https://example.test/ueber-uns')
    expect(english.canonicalUrl).toBe('https://example.test/en/about')
    expect(german.alternates).toEqual(english.alternates)
    expect(english.alternates).toEqual([
      { hrefLang: 'de', url: 'https://example.test/ueber-uns' },
      { hrefLang: 'en-GB', url: 'https://example.test/en/about' },
      { hrefLang: 'x-default', url: 'https://example.test/ueber-uns' },
    ])
    expect(renderLocalizedSeoLinks(english)).toContain('rel="canonical" href="https://example.test/en/about"')
    expect(renderLocalizedSeoLinks(english)).not.toContain('/ar/')
  })

  it('does not invent x-default when the primary version is offline', () => {
    const inventory = createPublishedRouteInventory([de, ar], [candidate(de, '/ueber-uns', 'offline'), candidate(ar, '/ar/about')])
    const seo = buildLocalizedSeo(inventory, inventory.routes[0], 'https://example.test')!
    expect(seo.language).toBe('ar')
    expect(seo.direction).toBe('rtl')
    expect(seo.alternates).toEqual([{ hrefLang: 'ar', url: 'https://example.test/ar/about' }])
  })

  it('does not emit SEO for a stale route after that variant was retracted', () => {
    const original = createPublishedRouteInventory([de, en], [candidate(de, '/ueber-uns'), candidate(en, '/en/about')])
    const retracted = createPublishedRouteInventory([de, en], [candidate(de, '/ueber-uns'), candidate(en, '/en/about', 'offline')])
    expect(buildLocalizedSeo(retracted, original.routes[1], 'https://example.test')).toBeNull()
  })

  it('uses only online public URLs in the sitemap with each reciprocal alternate set', () => {
    const inventory = createPublishedRouteInventory([de, en, ar], [
      candidate(de, '/ueber-uns'), candidate(en, '/en/about'), candidate(ar, '/ar/about', 'offline'),
      { ...candidate(de, '/internal-template'), contentId: 'template', kind: 'template', path: undefined },
    ])
    const sitemap = buildLocalizedSitemap(inventory, 'https://example.test')
    expect(sitemap.match(/<url>/g)).toHaveLength(2)
    expect(sitemap.match(/hreflang="de"/g)).toHaveLength(2)
    expect(sitemap.match(/hreflang="en-GB"/g)).toHaveLength(2)
    expect(sitemap).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(sitemap).toContain('<lastmod>2026-09-07T12:00:00.000Z</lastmod>')
    expect(sitemap).not.toContain('/ar/')
    expect(sitemap).not.toContain('internal-template')
  })

  it('escapes XML attributes and locations without changing the live URL', () => {
    const inventory = createPublishedRouteInventory([de], [candidate(de, '/research&development')])
    const sitemap = buildLocalizedSitemap(inventory, 'https://example.test')
    expect(sitemap).toContain('/research%26development</loc>')
    const links = renderLocalizedSeoLinks({ language: 'de', direction: 'ltr', canonicalUrl: 'https://example.test/?a=1&b="x"', alternates: [] })
    expect(links).toContain('&amp;')
    expect(links).toContain('&quot;')
  })

  it('accepts configured HTTP origins and rejects request-like or executable URLs', () => {
    expect(normalizePublicOrigin('https://example.test/')).toBe('https://example.test')
    expect(normalizePublicOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    for (const invalid of ['javascript:alert(1)', '//example.test', 'https://user:secret@example.test', 'https://example.test/subdir', 'https://example.test/?q=x']) {
      expect(() => normalizePublicOrigin(invalid)).toThrow()
    }
  })
})
