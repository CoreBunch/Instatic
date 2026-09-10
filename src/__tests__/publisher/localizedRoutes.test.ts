import { describe, expect, it } from 'bun:test'
import type { Locale } from '@core/localization-schema'
import {
  assertLocalePathPrefixAvailable,
  buildLocalizedPath,
  createPublishedRouteInventory,
  findPublishedContentRoute,
  inventoryFromPublishedManifest,
  localeForPublishedPath,
  LocalizedRouteError,
  normalizePublishedPath,
  publishedRouteAlternatives,
  resolvePublishedRoute,
  type PublishedRouteCandidate,
} from '@core/localization-routing'

const de: Locale = { id: 'de', code: 'de', name: 'Deutsch', pathPrefix: '', isDefault: true, enabled: true, direction: 'ltr' }
const en: Locale = { id: 'en', code: 'en', name: 'English', pathPrefix: 'en', isDefault: false, enabled: true, direction: 'ltr' }
const ar: Locale = { id: 'ar', code: 'ar', name: 'العربية', pathPrefix: 'ar', isDefault: false, enabled: false, direction: 'rtl' }

function candidate(overrides: Partial<PublishedRouteCandidate> = {}): PublishedRouteCandidate {
  return {
    contentId: 'about', localeId: de.id, publishedVersionId: 'version-de',
    siteSnapshotId: 'snapshot-1', tableId: 'pages', tableSlug: 'pages',
    kind: 'page', path: '/ueber-uns', availability: 'online', ...overrides,
  }
}

describe('localized public paths', () => {
  it('keeps the original default homepage and creates locale homepages', () => {
    expect(buildLocalizedPath(de, 'index')).toBe('/')
    expect(buildLocalizedPath(en, 'index')).toBe('/en')
    expect(buildLocalizedPath(en, 'company/about')).toBe('/en/company/about')
  })

  it('translates collection route bases while preserving an item named index', () => {
    expect(buildLocalizedPath(en, 'launch', '/news')).toBe('/en/news/launch')
    expect(buildLocalizedPath(de, 'start', '/neuigkeiten')).toBe('/neuigkeiten/start')
    expect(buildLocalizedPath(en, 'index', '/')).toBe('/en/index')
  })

  it('normalizes Unicode and percent-encoded equivalents to one collision key', () => {
    expect(normalizePublishedPath('/u\u0308ber-uns/')).toBe('/%C3%BCber-uns')
    expect(normalizePublishedPath('/%c3%bcber-uns')).toBe('/%C3%BCber-uns')
  })

  it.each(['/../secret', '/%2e%2e/secret', '/en%2fadmin', '/en%5cadmin', '/bad%zz', '/bad%00', '/x?locale=en', '/x#en', '/en//x'])(
    'rejects ambiguous or unsafe path %s', (path) => {
      expect(() => normalizePublishedPath(path)).toThrow(LocalizedRouteError)
    },
  )

  it('rejects locale prefixes and default paths owned by the server', () => {
    for (const prefix of ['admin', '_instatic', 'uploads', 'health', 'sitemap.xml']) {
      expect(() => buildLocalizedPath({ pathPrefix: prefix }, 'index')).toThrow(LocalizedRouteError)
      expect(() => buildLocalizedPath(de, `${prefix}/child`)).toThrow(LocalizedRouteError)
    }
  })

  it('rejects adding a locale that claims a currently live default-language path', () => {
    expect(() => assertLocalePathPrefixAvailable(en, [{ localeId: de.id, path: '/en/existing' }])).toThrow(LocalizedRouteError)
    expect(() => assertLocalePathPrefixAvailable(en, [{ localeId: de.id, path: '/english' }])).not.toThrow()
    expect(() => assertLocalePathPrefixAvailable(en, [{ localeId: en.id, path: '/en/about' }])).not.toThrow()
  })

  it('does not route a disabled locale namespace to the default-language 404', () => {
    expect(localeForPublishedPath([de, en, ar], '/ar/missing')).toBeNull()
    expect(localeForPublishedPath([de, en, ar], '/en/missing')?.id).toBe('en')
    expect(localeForPublishedPath([de, en, ar], '/missing')?.id).toBe('de')
  })
})

describe('published locale inventory', () => {
  it('only exposes independently published online variants', () => {
    const inventory = createPublishedRouteInventory([de, en, ar], [
      candidate(),
      candidate({ localeId: en.id, availability: 'offline', path: '/en/about', publishedVersionId: 'version-en' }),
      candidate({ localeId: ar.id, path: '/ar/about', publishedVersionId: 'version-ar' }),
      candidate({ contentId: 'new', path: '/new', publishedVersionId: null }),
    ])
    expect(inventory.routes.map((route) => route.path)).toEqual(['/ueber-uns'])
    expect(resolvePublishedRoute(inventory, '/en/about')).toBeNull()
    expect(findPublishedContentRoute(inventory, 'about', en.id)).toBeNull()
    expect(publishedRouteAlternatives(inventory, 'about').map((route) => route.localeId)).toEqual(['de'])
  })

  it('does not require the default variant to be online', () => {
    const inventory = createPublishedRouteInventory([de, en], [
      candidate({ availability: 'offline' }),
      candidate({ localeId: en.id, path: '/en/about', publishedVersionId: 'version-en' }),
    ])
    expect(resolvePublishedRoute(inventory, '/ueber-uns')).toBeNull()
    expect(resolvePublishedRoute(inventory, '/en/about')?.localeId).toBe('en')
  })

  it('keeps the immutable published path when the draft prefix has changed', () => {
    const inventory = createPublishedRouteInventory([de, { ...en, pathPrefix: 'english' }], [
      candidate({ localeId: en.id, path: '/en/about', publishedVersionId: 'version-en' }),
    ])
    expect(resolvePublishedRoute(inventory, '/en/about/')?.publishedVersionId).toBe('version-en')
    expect(resolvePublishedRoute(inventory, '/english/about')).toBeNull()
  })

  it('keeps published templates as dependencies without creating their own URL', () => {
    const inventory = createPublishedRouteInventory([de], [candidate({ kind: 'template', path: undefined })])
    expect(inventory.routes).toEqual([])
    expect(inventory.dependencies[0].contentId).toBe('about')
    expect(resolvePublishedRoute(inventory, '/ueber-uns')).toBeNull()
    expect(publishedRouteAlternatives(inventory, 'about')).toEqual([])
  })

  it('reserves configured language prefixes even while that language is disabled', () => {
    for (const path of ['/en', '/en/about', '/ar/private']) {
      expect(() => createPublishedRouteInventory([de, en, ar], [candidate({ path })])).toThrow(LocalizedRouteError)
    }
  })

  it('rejects a page and a CMS item competing for the same canonical URL', () => {
    expect(() => createPublishedRouteInventory([de], [
      candidate({ path: '/news/launch' }),
      candidate({ contentId: 'launch', kind: 'row', tableId: 'posts', tableSlug: 'posts', path: '/news/launch/' }),
    ])).toThrow(LocalizedRouteError)
  })

  it('rejects conflicting percent-encoded URLs and duplicate live variants', () => {
    expect(() => createPublishedRouteInventory([de], [
      candidate({ path: '/über-uns' }), candidate({ contentId: 'other', path: '/%C3%BCber-uns' }),
    ])).toThrow(LocalizedRouteError)
    expect(() => createPublishedRouteInventory([de], [candidate(), candidate({ path: '/other' })])).toThrow(LocalizedRouteError)
  })

  it('rejects duplicate frozen language codes for the same content after a language is renamed', () => {
    const renamed = { ...en, code: 'en-GB' }
    const replacement = { ...ar, code: 'en', enabled: true }
    const original = candidate({ localeId: en.id, path: '/en/about', languageCode: 'EN' })
    const translated = candidate({ localeId: ar.id, path: '/ar/about', languageCode: 'en' })
    expect(() => createPublishedRouteInventory([de, renamed, replacement], [original, translated])).toThrow(LocalizedRouteError)
    expect(() => createPublishedRouteInventory([de, renamed, replacement], [
      original, { ...translated, availability: 'offline' },
    ])).not.toThrow()
    expect(() => createPublishedRouteInventory([de, renamed, replacement], [
      original, { ...translated, contentId: 'different' },
    ])).not.toThrow()
  })

  it('restores a validated manifest with the same visibility and indexes', () => {
    const original = createPublishedRouteInventory([de, en], [
      candidate(), candidate({ contentId: 'layout', kind: 'template', path: undefined }),
    ])
    const restored = inventoryFromPublishedManifest({ locales: original.locales, routes: original.routes, dependencies: original.dependencies })
    expect(resolvePublishedRoute(restored, '/ueber-uns')).toEqual(resolvePublishedRoute(original, '/ueber-uns'))
    expect(restored.dependencies).toEqual(original.dependencies)
  })

  it('returns no route for malformed public requests', () => {
    const inventory = createPublishedRouteInventory([de], [candidate()])
    expect(resolvePublishedRoute(inventory, '/bad%zz')).toBeNull()
  })
})
