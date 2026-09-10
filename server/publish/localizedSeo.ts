import { escapeHtml } from '@core/html-sanitize'
import {
  findPublishedContentRoute,
  normalizePublicOrigin,
  LocalizedRouteError,
  publishedRouteAlternatives,
  type PublishedRoute,
  type PublishedRouteInventory,
} from '@core/localization-routing'
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const LocalizedSeoSchema = Type.Object({
  language: Type.String(),
  direction: Type.Union([Type.Literal('ltr'), Type.Literal('rtl')]),
  canonicalUrl: Type.String(),
  alternates: Type.Array(Type.Object({
    hrefLang: Type.String(),
    url: Type.String(),
  })),
})

export type LocalizedSeo = Static<typeof LocalizedSeoSchema>

/**
 * Every live sibling lists the same alternatives, including itself. An
 * offline primary version does not produce an x-default URL or a fallback.
 */
export function buildLocalizedSeo(
  inventory: PublishedRouteInventory,
  route: PublishedRoute,
  publicOrigin: string,
): LocalizedSeo | null {
  const live = findPublishedContentRoute(inventory, route.contentId, route.localeId)
  if (!live || live.publishedVersionId !== route.publishedVersionId || live.path !== route.path) return null
  const origin = normalizePublicOrigin(publicOrigin)
  const localeById = new Map(inventory.locales.map((locale) => [locale.id, locale]))
  const locale = localeById.get(route.localeId)
  if (!locale || !locale.enabled) return null
  const variants = publishedRouteAlternatives(inventory, route.contentId)
  const alternates: LocalizedSeo['alternates'] = variants.flatMap((variant) => {
    const variantLocale = localeById.get(variant.localeId)
    return variantLocale ? [{ hrefLang: variant.languageCode ?? variantLocale.code, url: `${origin}${variant.path}` }] : []
  })
  const defaultVariant = variants.find((variant) => localeById.get(variant.localeId)?.isDefault)
  if (defaultVariant) alternates.push({ hrefLang: 'x-default', url: `${origin}${defaultVariant.path}` })
  return {
    language: route.languageCode ?? locale.code,
    direction: route.direction ?? locale.direction,
    canonicalUrl: `${origin}${route.path}`,
    alternates,
  }
}

export function renderLocalizedSeoLinks(seo: LocalizedSeo): string {
  return [
    `<link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}">`,
    ...seo.alternates.map((alternate) =>
      `<link rel="alternate" hreflang="${escapeHtml(alternate.hrefLang)}" href="${escapeHtml(alternate.url)}">`,
    ),
  ].join('\n')
}

/**
 * XML and head links use exactly the same live inventory. Protocol and
 * extension: sitemaps.org/protocol.html and Google's localized-versions docs.
 */
export function buildLocalizedSitemap(inventory: PublishedRouteInventory, publicOrigin: string): string {
  const origin = normalizePublicOrigin(publicOrigin)
  if (inventory.routes.length > 50_000) {
    throw new LocalizedRouteError('sitemap', 'A sitemap cannot contain more than 50,000 URLs.')
  }
  const entries = inventory.routes.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((route) => {
    const seo = buildLocalizedSeo(inventory, route, origin)
    if (!seo) return ''
    const lastModified = route.publishedAt ? new Date(route.publishedAt) : null
    const lastmod = lastModified && Number.isFinite(lastModified.getTime())
      ? `\n    <lastmod>${lastModified.toISOString()}</lastmod>`
      : ''
    const alternatives = seo.alternates.map((alternate) =>
      `    <xhtml:link rel="alternate" hreflang="${escapeHtml(alternate.hrefLang)}" href="${escapeHtml(alternate.url)}"/>`,
    ).join('\n')
    return `  <url>\n    <loc>${escapeHtml(seo.canonicalUrl)}</loc>${lastmod}\n${alternatives}\n  </url>`
  })
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    entries.join('\n') + '\n</urlset>'
}
