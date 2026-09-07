import type { Locale } from '@core/localization-schema'
import type { PublishedRoute } from './schemas'

/** Public content cannot claim namespaces owned by the server. */
const RESERVED_PUBLIC_PREFIXES = new Set([
  'admin', '_instatic', 'uploads', 'api', 'assets', 'health', 'sitemap.xml', 'robots.txt',
])

export class LocalizedRouteError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(message)
    this.name = 'LocalizedRouteError'
    this.path = path
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function decodeSegment(segment: string, path: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    throw new LocalizedRouteError(path, 'The URL path contains invalid percent encoding.')
  }
  if (decoded === '.' || decoded === '..' || /[/\\]/u.test(decoded) || containsControlCharacter(decoded)) {
    throw new LocalizedRouteError(path, 'The URL path contains an invalid path segment.')
  }
  return decoded.normalize('NFC')
}

/**
 * One URL representation for collision checks, manifests and lookups. Decode
 * each segment separately: an encoded slash must never become a separator.
 */
export function normalizePublishedPath(path: string): string {
  if (/[?#\\]/u.test(path) || containsControlCharacter(path)) {
    throw new LocalizedRouteError(path, 'A public path cannot contain a query, fragment, backslash or control character.')
  }
  const segments = path.replace(/^\/+|\/+$/g, '').split('/')
  if (segments.length === 1 && segments[0] === '') return '/'
  if (segments.some((segment) => segment === '')) {
    throw new LocalizedRouteError(path, 'A public path cannot contain an empty path segment.')
  }
  return `/${segments.map((segment) => encodeURIComponent(decodeSegment(segment, path))).join('/')}`
}

export function assertPublicContentPath(path: string): void {
  const normalized = normalizePublishedPath(path)
  const first = decodeURIComponent(normalized.split('/')[1] ?? '').toLowerCase()
  if (RESERVED_PUBLIC_PREFIXES.has(first)) {
    throw new LocalizedRouteError(path, `The public path prefix "${first}" is reserved.`)
  }
}

/** A locale owns one top-level segment, or the unprefixed default namespace. */
export function normalizeLocalePathPrefix(prefix: string): string {
  const normalized = normalizePublishedPath(prefix)
  if (normalized === '/') return ''
  if (normalized.slice(1).includes('/')) {
    throw new LocalizedRouteError(prefix, 'A language URL prefix must be a single path segment.')
  }
  assertPublicContentPath(normalized)
  return normalized.slice(1)
}

/**
 * `index` is a homepage only for a page. A CMS item named index remains an
 * ordinary item at /<collection>/index, including a collection rooted at /.
 */
export function buildLocalizedPath(
  locale: Pick<Locale, 'pathPrefix'>,
  slug: string,
  routeBase?: string,
): string {
  const prefix = normalizeLocalePathPrefix(locale.pathPrefix)
  const slugPath = normalizePublishedPath(slug)
  const contentPath = routeBase === undefined
    ? (slugPath === '/index' ? '/' : slugPath)
    : `${normalizePublishedPath(routeBase).replace(/\/$/, '')}${slugPath}`
  const path = normalizePublishedPath(`${prefix ? `/${prefix}` : ''}${contentPath}`)
  assertPublicContentPath(path)
  return path
}

/** Adding or renaming a locale cannot claim another locale's live URLs. */
export function assertLocalePathPrefixAvailable(
  locale: Pick<Locale, 'id' | 'pathPrefix'>,
  routes: readonly Pick<PublishedRoute, 'localeId' | 'path'>[],
): void {
  const prefix = normalizeLocalePathPrefix(locale.pathPrefix)
  if (prefix === '') return
  const root = `/${prefix}`
  const conflict = routes.find((route) => {
    const path = normalizePublishedPath(route.path)
    return route.localeId !== locale.id && (path === root || path.startsWith(`${root}/`))
  })
  if (conflict) {
    throw new LocalizedRouteError(locale.pathPrefix, `The language prefix "${prefix}" would claim the existing URL "${conflict.path}".`)
  }
}

/**
 * Resolve the locale for an unknown URL (for example a localized 404).
 * Disabled prefixes still own their namespace, so they cannot fall back to
 * the default language. Existing public routes are resolved from the manifest.
 */
export function localeForPublishedPath(locales: readonly Locale[], path: string): Locale | null {
  let firstSegment: string
  try {
    firstSegment = normalizePublishedPath(path).split('/')[1] ?? ''
  } catch (error) {
    if (error instanceof LocalizedRouteError) return null
    throw error
  }
  const prefixed = locales.find((locale) => {
    const prefix = normalizeLocalePathPrefix(locale.pathPrefix)
    return prefix !== '' && prefix === firstSegment
  })
  if (prefixed) return prefixed.enabled ? prefixed : null
  return locales.find((locale) => locale.isDefault && locale.enabled) ?? null
}
