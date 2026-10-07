import { describe, expect, it } from 'bun:test'
import { assertSiteTranslations, publishPage } from '@core/publisher'
import { LocalizationError } from '@core/localization'
import { parsePage, PageSeoValidationError, type PageSeo } from '@core/page-tree'
import { composeTemplateChain } from '@core/templates/templateCompose'
import { makePage, makeSite, makeModule, makeRegistry } from './helpers'
import { buildSiteCssBundle } from '../../../server/publish/siteCssBundle'

const registry = makeRegistry({ 'base.body': makeModule('base.body') })
function fixture() {
  const page = makePage({ root: { moduleId: 'base.body' } })
  page.seo = {
    title: 'Specific {page.title}', description: 'Description & details', canonical: 'https://example.com{page.permalink}',
    alternates: [{ id: 'fr', language: 'fr', href: '/fr?x=1&y=2' }, { id: 'default', language: 'x-default', href: '/' }],
    meta: [
      { id: 'robots-1', attribute: 'name', key: 'robots', content: 'index' },
      { id: 'robots-2', attribute: 'name', key: 'robots', content: 'max-image-preview:large' },
      { id: 'theme-light', attribute: 'name', key: 'theme-color', content: '#fff', media: '(prefers-color-scheme: light)' },
      { id: 'theme-dark', attribute: 'name', key: 'theme-color', content: '#000', media: '(prefers-color-scheme: dark)' },
      { id: 'og', attribute: 'property', key: 'og:title', content: '{page.title}' },
    ],
    links: [{ id: 'icon', rel: 'icon', href: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
    structuredData: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: '{page.title}',
      value: '</script><script>alert(1)</script><!--', nested: [true, null, { name: '{site.name}' }] }],
  }
  const site = makeSite({ pages: [page] })
  site.settings.metaTitle = 'Global default'
  site.settings.metaDescription = 'Global description'
  site.settings.faviconUrl = '/default.ico'
  return { page, site }
}

describe('native page SEO', () => {
  it('publishes authored metadata, ordered duplicates, alternatives and inert JSON-LD', () => {
    const { page, site } = fixture()
    const { html } = publishPage(page, site, registry)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.title).toBe('Specific Test Page')
    expect(doc.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('Description & details')
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://example.com/')
    expect(doc.querySelectorAll('link[rel="alternate"]')).toHaveLength(2)
    expect(doc.querySelector('link[hreflang="fr"]')?.getAttribute('href')).toBe('/fr?x=1&y=2')
    expect([...doc.querySelectorAll('meta[name="robots"]')].map((node) => node.getAttribute('content'))).toEqual(['index', 'max-image-preview:large'])
    expect(doc.querySelectorAll('meta[name="theme-color"][media]')).toHaveLength(2)
    expect(doc.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
    expect(doc.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/icon.svg')
    const script = doc.querySelector('script')!
    expect(script.getAttribute('type')).toBe('application/ld+json')
    expect(JSON.parse(script.textContent ?? '')).toEqual({ ...page.seo!.structuredData![0], name: 'Test Page', nested: [true, null, { name: 'Test SiteDocument' }] })
    expect(doc.querySelectorAll('script')).toHaveLength(1)
    expect(html).toContain("script-src 'none'")
    expect(html).not.toContain('</script><script>alert')
  })

  it('uses the same metadata for inline and external rendering without leaking into page bindings', () => {
    const { page, site } = fixture()
    const inline = publishPage(page, site, registry).html
    const external = publishPage(page, site, registry, { cssEmission: 'external', cssBundle: buildSiteCssBundle(site, registry, page) }).html
    expect(external).toContain('rel="stylesheet"')
    const metaOf = (html: string) => new DOMParser().parseFromString(html, 'text/html').head.innerHTML
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<link rel="stylesheet"[^>]*>/g, '').replace(/\s+/g, ' ')
    expect(metaOf(inline)).toBe(metaOf(external))
    expect(page.title).toBe('Test Page')
  })

  it('resolves template tokens and lets a row override only its title and description', () => {
    const { page, site } = fixture()
    page.seo!.title = '{currentEntry.name} | {site.name}'
    page.seo!.canonical = 'https://example.com/{currentEntry.slug}'
    const { html } = publishPage(page, site, registry, {
      documentMeta: { title: 'Entry override', description: 'Entry description' },
      templateContext: { entryStack: [{ id: 'entry', fields: { name: 'Entry name', slug: 'entry-slug' } }] },
    })
    expect(html).toContain('<title>Entry override</title>')
    expect(html).toContain('content="Entry description"')
    expect(html).toContain('href="https://example.com/entry-slug"')
    delete page.seo
    expect(publishPage(page, site, registry).html).toContain('<title>Global default</title>')
  })

  it('retains the terminal page metadata across template composition', () => {
    const { page } = fixture()
    const template = makePage({ root: { moduleId: 'base.body', children: ['outlet'] }, outlet: { moduleId: 'base.outlet' } })
    template.id = 'template'
    template.seo = { title: 'Template SEO' }
    expect(composeTemplateChain([template], { kind: 'page', page }).seo).toEqual(page.seo)
    expect(composeTemplateChain([template], { kind: 'entry' }).seo).toEqual(template.seo)
  })

  it('fails explicitly on unsafe/unsupported metadata and resolved URLs', () => {
    const { page, site } = fixture()
    for (const seo of [
      { canonical: 'javascript:alert(1)' },
      { meta: [{ id: 'csp', attribute: 'http-equiv', key: 'Content-Security-Policy', content: 'default-src *' }] },
      { links: [{ id: 'css', rel: 'stylesheet', href: '/global.css' }] },
      { structuredData: [{ nested: { invalid: undefined } }] },
    ]) {
      expect(() => parsePage({ ...page, seo }, 0)).toThrow(PageSeoValidationError)
    }
    page.seo = { canonical: '{currentEntry.url}' }
    expect(() => publishPage(page, site, registry, { templateContext: { entryStack: [{ id: 'bad', fields: { url: 'javascript:alert(1)' } }] } })).toThrow(PageSeoValidationError)
    page.seo = { title: '<script>alert(1)</script>', description: '" onload="alert(1)' } satisfies PageSeo
    expect(publishPage(page, site, registry).html).toContain('&lt;script&gt;')
  })
  it('grants only emitted manifest origins in the native CSP, without executable script permission', () => {
    const { page, site } = fixture()
    page.seo = { links: [{ id: 'manifest', rel: 'manifest', href: 'https://assets.example.com/manifest.json' }] }
    const html = publishPage(page, site, registry).html
    expect(html).toContain('manifest-src https://assets.example.com;')
    expect(html).toContain("script-src 'none'")
    for (const [href, source] of [
      [' \thttps://assets.example.com/app.json', 'https://assets.example.com'],
      ['HTTPS:/assets.example.com/app.json', 'https://assets.example.com'],
      [' //cdn.example.com:8443/app.json', 'cdn.example.com:8443'],
      ['/app.webmanifest', "'self'"],
    ]) {
      page.seo.links![0].href = href
      expect(publishPage(page, site, registry).html).toContain(`manifest-src ${source};`)
    }
    delete page.seo
    expect(publishPage(page, site, registry).html).not.toContain('manifest-src')
  })
  it('resolves the native page-language catalogue in SEO and preflights every metadata string source', () => {
    const { page, site } = fixture()
    site.settings.localization = { catalogues: ['it', 'en'].map((language) => ({ language, fileId: language })) }
    site.settings.language = 'it'
    site.files = ['it', 'en'].map((language) => ({ id: language, path: `locales/${language}.json`, type: 'config',
      content: JSON.stringify({ language, messages: { label: language === 'it' ? 'Titolo' : 'English title' } }), createdAt: 0, updatedAt: 0 }))
    page.language = 'en'
    page.seo = { title: '{site.translations.label}', structuredData: [{ nested: [{ name: '{site.translations.label}' }] }] }
    assertSiteTranslations(site)
    const html = publishPage(page, site, registry).html
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>English title</title>')
    expect(html).toContain('"name":"English title"')
    for (const seo of [
      { title: '{site.translations.missing}' }, { description: '{site.translations.missing}' },
      { canonical: '{site.translations.missing}' },
      { alternates: [{ id: 'en', language: 'en', href: '{site.translations.missing}' }] },
      { meta: [{ id: 'theme', attribute: 'name' as const, key: 'theme-color', content: '{site.translations.missing}' }] },
      { links: [{ id: 'manifest', rel: 'manifest' as const, href: '{site.translations.missing}' }] },
      { structuredData: [{ nested: [{ value: '{site.translations.missing}' }] }] },
    ]) {
      page.seo = seo
      expect(() => assertSiteTranslations(site)).toThrow(LocalizationError)
    }
  })
})
