/**
 * JSON-LD structured data builders — schema.org entities generated
 * automatically from resolved SEO metadata. Zero configuration in v1:
 * no per-target schema editor, the builders derive everything from the
 * same resolved values the meta tags use.
 *
 *   - Homepage (`routePath === '/'`): `WebSite`, plus `Organization` when
 *     site organization defaults are set.
 *   - Row routes: `Article` (headline, description, image, dates).
 *   - Routes deeper than one segment: `BreadcrumbList`.
 *
 * Entities that require absolute URLs are omitted when no public origin is
 * configured. `noindex` targets emit no JSON-LD at all.
 *
 * `serializeJsonLd` escapes `</script` and `<!--` so user-controlled strings
 * cannot break out of the `<script type="application/ld+json">` element.
 * JSON-LD is non-executing, so no CSP change is needed.
 */

import type { SeoOrganization } from './schema'
import type { ResolvedSeoMetadata } from './resolve'
import { absoluteUrl } from './resolve'

export interface JsonLdContext {
  kind: 'page' | 'row'
  routePath: string
  origin?: string
  siteName: string
  organization?: SeoOrganization
}

export type JsonLdEntity = Record<string, unknown>

function breadcrumbList(ctx: JsonLdContext): JsonLdEntity | null {
  if (!ctx.origin) return null
  const segments = ctx.routePath.split('/').filter(Boolean)
  if (segments.length < 2) return null

  const items = [
    {
      '@type': 'ListItem',
      position: 1,
      name: ctx.siteName,
      item: absoluteUrl(ctx.origin, '/'),
    },
    ...segments.map((segment, index) => ({
      '@type': 'ListItem',
      position: index + 2,
      name: decodeURIComponent(segment),
      item: absoluteUrl(ctx.origin!, `/${segments.slice(0, index + 1).join('/')}`),
    })),
  ]
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  }
}

/**
 * Build the JSON-LD entities for one route. Returns `[]` for noindex
 * targets — content excluded from search must not advertise itself to
 * answer engines either.
 */
export function buildJsonLdEntities(
  resolved: ResolvedSeoMetadata,
  ctx: JsonLdContext,
): JsonLdEntity[] {
  if (resolved.noindex) return []

  const entities: JsonLdEntity[] = []
  const isHomepage = ctx.routePath === '/'

  if (isHomepage && ctx.origin) {
    entities.push({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: ctx.siteName,
      url: absoluteUrl(ctx.origin, '/'),
    })
    const org = ctx.organization
    if (org?.name) {
      entities.push({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: org.name,
        url: absoluteUrl(ctx.origin, '/'),
        ...(org.logoUrl ? { logo: org.logoUrl } : {}),
      })
    }
  }

  if (ctx.kind === 'row') {
    entities.push({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: resolved.title,
      ...(resolved.description ? { description: resolved.description } : {}),
      ...(resolved.ogImage ? { image: resolved.ogImage } : {}),
      ...(resolved.canonicalUrl ? { mainEntityOfPage: resolved.canonicalUrl } : {}),
      ...(resolved.articlePublishedTime ? { datePublished: resolved.articlePublishedTime } : {}),
      ...(resolved.articleModifiedTime ? { dateModified: resolved.articleModifiedTime } : {}),
    })
  }

  const breadcrumbs = breadcrumbList(ctx)
  if (breadcrumbs) entities.push(breadcrumbs)

  return entities
}

/**
 * Serialize one entity for embedding in `<script type="application/ld+json">`.
 * Escapes the two sequences that could terminate or corrupt the script
 * element when they appear inside user-controlled string values.
 */
export function serializeJsonLd(entity: JsonLdEntity): string {
  return JSON.stringify(entity)
    .replaceAll('</script', '<\\/script')
    .replaceAll('<!--', '\\u003C!--')
}
