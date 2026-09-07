import type { Locale } from '@core/localization-schema'
import type {
  PublishedDependency,
  PublishedRoute,
  PublishedRouteCandidate,
  PublishedRouteManifest,
} from './schemas'
import { assertPublicContentPath, LocalizedRouteError, normalizeLocalePathPrefix, normalizePublishedPath } from './paths'

export interface PublishedRouteInventory extends PublishedRouteManifest {
  readonly byPath: ReadonlyMap<string, PublishedRoute>
  readonly byContent: ReadonlyMap<string, ReadonlyMap<string, PublishedRoute>>
}

function validateLocales(locales: readonly Locale[]): void {
  const ids = new Set<string>()
  const codes = new Set<string>()
  const prefixes = new Set<string>()
  let defaults = 0
  for (const locale of locales) {
    const prefix = normalizeLocalePathPrefix(locale.pathPrefix)
    if (ids.has(locale.id) || codes.has(locale.code.toLowerCase()) || prefixes.has(prefix)) {
      throw new LocalizedRouteError(`locales.${locale.id}`, 'Language identities, codes and URL prefixes must be unique.')
    }
    if ((locale.isDefault && prefix !== '') || (!locale.isDefault && prefix === '')) {
      throw new LocalizedRouteError(`locales.${locale.id}.pathPrefix`, 'Only the default language may use the site root.')
    }
    ids.add(locale.id)
    codes.add(locale.code.toLowerCase())
    prefixes.add(prefix)
    if (locale.isDefault) defaults += 1
  }
  if (defaults !== 1) {
    throw new LocalizedRouteError('locales', 'The site must have exactly one default language.')
  }
}

/**
 * Visibility is explicit: missing/offline variants and disabled locales never
 * become public through inheritance. Published paths are already frozen on
 * the version; editing a draft prefix or slug cannot rename a live route.
 */
export function createPublishedRouteInventory(
  locales: readonly Locale[],
  candidates: readonly PublishedRouteCandidate[],
): PublishedRouteInventory {
  validateLocales(locales)
  const localeById = new Map(locales.map((locale) => [locale.id, locale]))
  const routes: PublishedRoute[] = []
  const dependencies: PublishedDependency[] = []
  const byPath = new Map<string, PublishedRoute>()
  const byContent = new Map<string, Map<string, PublishedRoute>>()
  const seenVariants = new Map<string, Set<string>>()

  for (const candidate of candidates) {
    const locale = localeById.get(candidate.localeId)
    if (!locale) {
      throw new LocalizedRouteError(candidate.contentId, `Unknown language "${candidate.localeId}" in the publish inventory.`)
    }
    if (!locale.enabled || candidate.availability !== 'online' || candidate.publishedVersionId === null) continue

    const seenLocales = seenVariants.get(candidate.contentId) ?? new Set<string>()
    if (seenLocales.has(candidate.localeId)) {
      throw new LocalizedRouteError(candidate.contentId, 'A content item can have only one live version per language.')
    }
    seenLocales.add(candidate.localeId)
    seenVariants.set(candidate.contentId, seenLocales)

    const { availability: _availability, path: candidatePath, ...identity } = candidate
    const publishedVersionId = candidate.publishedVersionId
    if (candidate.kind === 'template') {
      dependencies.push({ ...identity, kind: 'template', publishedVersionId })
      continue
    }
    if (candidatePath === undefined) {
      throw new LocalizedRouteError(candidate.contentId, 'A published page or CMS item must have a frozen public path.')
    }
    const path = normalizePublishedPath(candidatePath)
    assertPublicContentPath(path)
    const firstSegment = path.split('/')[1] ?? ''
    const namespace = locales.find((entry) => !entry.isDefault && normalizeLocalePathPrefix(entry.pathPrefix) === firstSegment)
    if (namespace && namespace.id !== candidate.localeId) {
      throw new LocalizedRouteError(path, `The URL prefix "${firstSegment}" belongs to language "${namespace.name}".`)
    }
    const conflict = byPath.get(path)
    if (conflict) {
      throw new LocalizedRouteError(path, `The URL "${path}" is used by both "${conflict.contentId}" and "${candidate.contentId}".`)
    }
    const contentLocales = byContent.get(candidate.contentId) ?? new Map<string, PublishedRoute>()
    const languageCode = (candidate.languageCode ?? locale.code).toLowerCase()
    for (const sibling of contentLocales.values()) {
      const siblingCode = sibling.languageCode ?? localeById.get(sibling.localeId)!.code
      if (siblingCode.toLowerCase() === languageCode) {
        throw new LocalizedRouteError(candidate.contentId,
          `The language code "${languageCode}" is already published for this content in another language. Republish the renamed language before publishing this translation.`)
      }
    }
    const route: PublishedRoute = { ...identity, kind: candidate.kind, publishedVersionId, path }
    routes.push(route)
    byPath.set(path, route)
    contentLocales.set(route.localeId, route)
    byContent.set(route.contentId, contentLocales)
  }

  return { locales: [...locales], routes, dependencies, byPath, byContent }
}

export function resolvePublishedRoute(inventory: PublishedRouteInventory, path: string): PublishedRoute | null {
  try {
    return inventory.byPath.get(normalizePublishedPath(path)) ?? null
  } catch (error) {
    if (error instanceof LocalizedRouteError) return null
    throw error
  }
}

export function findPublishedContentRoute(
  inventory: PublishedRouteInventory,
  contentId: string,
  localeId: string,
): PublishedRoute | null {
  return inventory.byContent.get(contentId)?.get(localeId) ?? null
}

/** Alternatives follow the configured language order, with no guessed URLs. */
export function publishedRouteAlternatives(
  inventory: PublishedRouteInventory,
  contentId: string,
): PublishedRoute[] {
  const variants = inventory.byContent.get(contentId)
  if (!variants) return []
  return inventory.locales.flatMap((locale) => {
    const route = variants.get(locale.id)
    return route ? [route] : []
  })
}

/** Rebuild indexes when a manifest was read from storage and schema-validated. */
export function inventoryFromPublishedManifest(manifest: PublishedRouteManifest): PublishedRouteInventory {
  return createPublishedRouteInventory(manifest.locales, [...manifest.routes, ...manifest.dependencies].map((entry) => ({
    ...entry,
    availability: 'online',
  })))
}

/** Switchers follow logical content identity; an absent translation has no link. */
export function publishedLanguageAlternatives(inventory: PublishedRouteInventory, route: PublishedRoute): import('./schemas').LanguageAlternative[] {
  const live = findPublishedContentRoute(inventory, route.contentId, route.localeId)
  if (!live || live.publishedVersionId !== route.publishedVersionId) return []
  return publishedRouteAlternatives(inventory, route.contentId).flatMap((variant) => {
    const locale = inventory.locales.find((entry) => entry.id === variant.localeId)
    return locale ? [{ localeId: locale.id, code: variant.languageCode ?? locale.code,
      name: locale.name, path: variant.path, current: locale.id === route.localeId }] : []
  })
}
