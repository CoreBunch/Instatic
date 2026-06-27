import { describe, expect, test } from 'bun:test'
import { buildJsonLdEntities, serializeJsonLd } from '../jsonLd'
import { resolveSeoMetadata } from '../resolve'

const ORIGIN = 'https://acme.com'

function resolvedFor(routePath: string, kind: 'page' | 'row', extra = {}) {
  return resolveSeoMetadata({
    siteName: 'Acme',
    routeKind: kind,
    routePath,
    origin: ORIGIN,
    baseTitle: 'Hello',
    ...extra,
  })
}

describe('buildJsonLdEntities', () => {
  test('homepage emits WebSite, and Organization when configured', () => {
    const entities = buildJsonLdEntities(resolvedFor('/', 'page'), {
      kind: 'page',
      routePath: '/',
      origin: ORIGIN,
      siteName: 'Acme',
      organization: { name: 'Acme Inc', logoUrl: 'https://acme.com/logo.png' },
    })
    const types = entities.map((e) => e['@type'])
    expect(types).toContain('WebSite')
    expect(types).toContain('Organization')
    const org = entities.find((e) => e['@type'] === 'Organization')!
    expect(org.logo).toBe('https://acme.com/logo.png')
  })

  test('homepage without organization emits WebSite only', () => {
    const entities = buildJsonLdEntities(resolvedFor('/', 'page'), {
      kind: 'page',
      routePath: '/',
      origin: ORIGIN,
      siteName: 'Acme',
    })
    expect(entities.map((e) => e['@type'])).toEqual(['WebSite'])
  })

  test('row routes emit Article with dates and BreadcrumbList when deep', () => {
    const resolved = resolvedFor('/posts/hello', 'row', {
      publishedAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-02T00:00:00Z',
    })
    const entities = buildJsonLdEntities(resolved, {
      kind: 'row',
      routePath: '/posts/hello',
      origin: ORIGIN,
      siteName: 'Acme',
    })
    const types = entities.map((e) => e['@type'])
    expect(types).toContain('Article')
    expect(types).toContain('BreadcrumbList')
    const article = entities.find((e) => e['@type'] === 'Article')!
    expect(article.headline).toBe('Hello')
    expect(article.datePublished).toBe('2026-06-01T00:00:00Z')
    expect(article.dateModified).toBe('2026-06-02T00:00:00Z')
    const breadcrumbs = entities.find((e) => e['@type'] === 'BreadcrumbList')!
    const items = breadcrumbs.itemListElement as { item: string; position: number }[]
    expect(items).toHaveLength(3)
    expect(items[2]!.item).toBe('https://acme.com/posts/hello')
  })

  test('single-segment page emits no breadcrumbs', () => {
    const entities = buildJsonLdEntities(resolvedFor('/about', 'page'), {
      kind: 'page',
      routePath: '/about',
      origin: ORIGIN,
      siteName: 'Acme',
    })
    expect(entities.map((e) => e['@type'])).not.toContain('BreadcrumbList')
  })

  test('noindex targets emit nothing', () => {
    const resolved = resolvedFor('/posts/hello', 'row', { target: { noindex: true } })
    expect(
      buildJsonLdEntities(resolved, {
        kind: 'row',
        routePath: '/posts/hello',
        origin: ORIGIN,
        siteName: 'Acme',
      }),
    ).toEqual([])
  })

  test('origin-dependent entities are omitted without an origin', () => {
    const resolved = resolveSeoMetadata({
      siteName: 'Acme',
      routeKind: 'page',
      routePath: '/',
      baseTitle: 'Home',
    })
    const entities = buildJsonLdEntities(resolved, {
      kind: 'page',
      routePath: '/',
      siteName: 'Acme',
      organization: { name: 'Acme Inc' },
    })
    expect(entities).toEqual([])
  })
})

describe('serializeJsonLd', () => {
  test('escapes script terminators and comment openers', () => {
    const out = serializeJsonLd({ name: 'x</script><script>x()</script>', note: '<!-- hi' })
    expect(out).not.toContain('</script')
    expect(out).not.toContain('<!--')
    // Round-trips back to the original values
    const parsed = JSON.parse(out) as { name: string; note: string }
    expect(parsed.name).toBe('x</script><script>x()</script>')
    expect(parsed.note).toBe('<!-- hi')
  })
})
