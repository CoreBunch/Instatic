/**
 * Per-page `<head>` settings (`page.seo`) in the published document: every
 * tag is emitted, escaped, URL-checked, and falls back to the site settings
 * where a site-level value exists.
 */
import { describe, it, expect } from 'bun:test'
import { publishPage, serializeJsonLd } from '@core/publisher'
import type { PageSeo } from '@core/page-tree'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'

const registry = makeRegistry({
  'base.text': makeModule('base.text', {
    render: (props) => ({ html: `<p>${String(props.text ?? '')}</p>` }),
  }),
})

function headOf(seo: PageSeo | undefined, settings: Record<string, string> = {}): string {
  const site = makeSite({ settings: { ...makeSite().settings, ...settings } })
  const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
  if (seo) page.seo = seo
  const { html } = publishPage(page, site, registry)
  return html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
}

describe('page head settings', () => {
  it('emits every head tag a page sets', () => {
    const head = headOf({
      title: 'Instatic 1.0',
      description: 'A self-hosted visual CMS.',
      canonical: 'https://instatic.com/',
      robots: 'index, follow, max-image-preview:large',
      colorScheme: 'light dark',
      themeColors: [
        { color: '#f3f3f1', media: '(prefers-color-scheme: light)' },
        { color: '#0a0a0b', media: '(prefers-color-scheme: dark)' },
      ],
      favicon: { href: '/uploads/logo.svg', type: 'image/svg+xml' },
      links: [
        { rel: 'alternate', href: '/llms.txt', type: 'text/plain', title: 'Instatic for language models' },
        { rel: 'preload', href: '/uploads/font.woff2', as: 'font', type: 'font/woff2', crossorigin: 'anonymous' },
      ],
      openGraph: { type: 'website', siteName: 'Instatic', title: 'OG title', image: 'https://instatic.com/og.png', imageAlt: 'The editor' },
      twitter: { card: 'summary_large_image', image: 'https://instatic.com/og.png' },
      meta: [{ attribute: 'property', name: 'og:image:width', content: '1200' }],
      jsonLd: ['{"@context":"https://schema.org","@type":"Organization","name":"Instatic"}'],
    })

    expect(head).toContain('<title>Instatic 1.0</title>')
    expect(head).toContain('<meta name="description" content="A self-hosted visual CMS.">')
    expect(head).toContain('<link rel="canonical" href="https://instatic.com/">')
    expect(head).toContain('<meta name="robots" content="index, follow, max-image-preview:large">')
    expect(head).toContain('<meta name="color-scheme" content="light dark">')
    expect(head).toContain('<meta name="theme-color" content="#f3f3f1" media="(prefers-color-scheme: light)">')
    expect(head).toContain('<meta name="theme-color" content="#0a0a0b" media="(prefers-color-scheme: dark)">')
    expect(head).toContain('<link rel="icon" href="/uploads/logo.svg" type="image/svg+xml">')
    expect(head).toContain('<link rel="alternate" href="/llms.txt" type="text/plain" title="Instatic for language models">')
    expect(head).toContain('<link rel="preload" href="/uploads/font.woff2" as="font" type="font/woff2" crossorigin="anonymous">')
    expect(head).toContain('<meta property="og:type" content="website">')
    expect(head).toContain('<meta property="og:site_name" content="Instatic">')
    expect(head).toContain('<meta property="og:title" content="OG title">')
    expect(head).toContain('<meta property="og:image" content="https://instatic.com/og.png">')
    expect(head).toContain('<meta property="og:image:alt" content="The editor">')
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(head).toContain('<meta property="og:image:width" content="1200">')
    expect(head).toContain('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Instatic"}</script>')
  })

  it('falls back to the site description, title and favicon', () => {
    const head = headOf(undefined, {
      metaTitle: 'Site title',
      metaDescription: 'Site description',
      faviconUrl: '/uploads/site.ico',
    })
    expect(head).toContain('<title>Site title</title>')
    expect(head).toContain('<meta name="description" content="Site description">')
    expect(head).toContain('<link rel="icon" href="/uploads/site.ico">')
  })

  it('page values outrank the site settings', () => {
    const head = headOf(
      { title: 'Page title', description: 'Page description', favicon: { href: '/uploads/page.svg' } },
      { metaTitle: 'Site title', metaDescription: 'Site description', faviconUrl: '/uploads/site.ico' },
    )
    expect(head).toContain('<title>Page title</title>')
    expect(head).toContain('content="Page description"')
    expect(head).not.toContain('Site description')
    expect(head).toContain('href="/uploads/page.svg"')
    expect(head).not.toContain('site.ico')
  })

  it('icon links on the page replace the site favicon instead of adding to it', () => {
    const head = headOf({ links: [{ rel: 'icon', href: '/uploads/32.png', sizes: '32x32' }] }, { faviconUrl: '/uploads/site.ico' })
    expect(head).toContain('<link rel="icon" href="/uploads/32.png" sizes="32x32">')
    expect(head).not.toContain('site.ico')
  })

  it('resolves page references to the target page path, and drops a link to a missing page', () => {
    const site = makeSite()
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const german = { ...makePage({ root: { moduleId: 'base.text', props: {} } }), id: 'page-de', slug: 'de' }
    site.pages = [page, german]
    page.seo = {
      canonical: 'cms:page:page-1?page=2#intro',
      links: [{ rel: 'alternate', href: 'cms:page:page-de', hreflang: 'de' }, { rel: 'alternate', href: 'cms:page:gone' }],
    }
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<link rel="canonical" href="/?page=2#intro">')
    expect(html).toContain('<link rel="alternate" href="/de" hreflang="de">')
    expect(html).not.toContain('cms:page')
    expect(html.match(/rel="alternate"/g)).toHaveLength(1)
  })

  it('a page without head settings emits no extra tags', () => {
    const head = headOf(undefined)
    expect(head).not.toContain('og:')
    expect(head).not.toContain('canonical')
    expect(head).not.toContain('application/ld+json')
  })

  it('drops URLs with unsafe schemes and escapes every attribute', () => {
    const head = headOf({
      canonical: 'javascript:alert(1)',
      favicon: { href: 'data:image/svg+xml,<svg onload=alert(1)>' },
      links: [{ rel: 'alternate', href: 'javascript:alert(1)' }],
      openGraph: { title: '"><script>alert(1)</script>', image: 'vbscript:x' },
      meta: [{ attribute: 'name', name: 'x-test', content: 'javascript:alert(1)' }],
      robots: '"><img src=x onerror=alert(1)>',
    })
    expect(head).not.toContain('javascript:')
    expect(head).not.toContain('vbscript:')
    expect(head).not.toContain('data:image')
    expect(head).not.toContain('<script>alert')
    expect(head).not.toContain('<img')
    expect(head).toContain('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  })

  it('JSON-LD cannot close its script element, and invalid JSON is omitted', () => {
    const head = headOf({
      jsonLd: [
        '{"name":"</script><script>alert(1)</script><!--"}',
        'not json',
        '"just a string"',
      ],
    })
    expect(head).not.toContain('</script><script>')
    expect(head).not.toContain('<!--')
    expect(head.match(/application\/ld\+json/g)).toHaveLength(1)
    expect(head).toContain('\\u003c/script\\u003e')
    expect(JSON.parse(serializeJsonLd('{"name":"</script>"}')!)).toEqual({ name: '</script>' })
  })

  it('allows an external web manifest in the CSP and keeps same-origin ones', () => {
    const external = headOf({ links: [{ rel: 'manifest', href: 'https://cdn.example/site.webmanifest' }] })
    expect(external).toMatch(/manifest-src 'self' https:\/\/cdn\.example/)
    expect(headOf({ links: [{ rel: 'manifest', href: '/site.webmanifest' }] })).not.toContain('manifest-src')
  })

  it('interpolates tokens in head text and URLs on entry routes', () => {
    const site = makeSite()
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.seo = {
      canonical: 'https://acme.test/posts/{currentEntry.slug}',
      openGraph: { title: '{currentEntry.name} | Acme' },
      jsonLd: ['{"@type":"BlogPosting","{currentEntry.name}":"{currentEntry.name}"}'],
    }
    const { html } = publishPage(page, site, registry, {
      templateContext: { entryStack: [{ id: 'row-1', fields: { name: 'Launch', slug: 'launch' } }] },
    })
    expect(html).toContain('<link rel="canonical" href="https://acme.test/posts/launch">')
    expect(html).toContain('<meta property="og:title" content="Launch | Acme">')
    // Values resolve, keys stay as authored.
    expect(html).toContain('{"@type":"BlogPosting","{currentEntry.name}":"Launch"}')
  })
})
