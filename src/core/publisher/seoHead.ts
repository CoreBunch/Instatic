/**
 * SEO `<head>` assembly for published pages.
 *
 * Owns the `<title>` + meta/link/JSON-LD emission and the page-level SEO
 * fallback resolution used when the caller didn't pre-resolve metadata.
 * The server passes a fully-resolved `PublishedSeo` (it knows the public
 * origin, row SEO cells, and entry templates); previews/exports fall back
 * to `resolvePageSeoFallback`, which runs the SAME `@core/seo` resolver —
 * one fallback engine everywhere, minus origin-dependent absolute URLs.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { buildPageFrame } from '@core/templates/contextFrames'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import {
  resolveSeoMetadata,
  buildJsonLdEntities,
  serializeJsonLd,
  type JsonLdEntity,
  type ResolvedSeoMetadata,
} from '@core/seo'
import { escapeHtml, isSafeUrl } from './utils'

/**
 * Resolved SEO payload for one published route: the final metadata values
 * the head tags emit, plus the schema.org JSON-LD entities. Built by
 * `resolveSeoMetadata` + `buildJsonLdEntities` from `@core/seo` — either by
 * the server caller (full context) or by `publishPage`'s internal fallback.
 */
export interface PublishedSeo {
  resolved: ResolvedSeoMetadata
  jsonLd: JsonLdEntity[]
}

/**
 * `<head>` metadata derived from the resolved SEO payload + site settings.
 *
 * - Every text value is escapeHtml()'d; URL-typed values (canonical, images,
 *   favicon) are additionally validated by isSafeUrl() (blocks
 *   `javascript:` / `vbscript:` schemes).
 * - `noindex` emits `noindex` only — a noindexed page's links still pass
 *   crawl equity, so `nofollow` is never bundled silently.
 * - JSON-LD entities are serialized with `serializeJsonLd`, which escapes
 *   `</script` and `<!--` so user strings cannot break out of the element.
 * - `lang` honours WCAG 2.1 AA SC 3.1.1 and escapes the BCP-47 tag
 *   because settings.language is user-controlled.
 */
export interface DocumentMetaTags {
  /** `<title>` + every SEO meta/link/JSON-LD line, two-space indented. */
  seoHeadHtml: string
  favicon: string
  langAttr: string
}

/**
 * Resolve the page-level SEO fallback when the caller didn't pass
 * `options.seo`. Covers previews, exports, and tests — same resolver as the
 * server path, with title patterns interpolated against the composed
 * template context. No origin is available here, so absolute URLs
 * (canonical, og:url) and origin-dependent JSON-LD are omitted.
 */
export function resolvePageSeoFallback(
  page: Page,
  site: SiteDocument,
  templateContext: TemplateRenderDataContext,
): PublishedSeo {
  const pageFrame = buildPageFrame(page)
  const resolved = resolveSeoMetadata({
    target: page.seo,
    siteSeo: site.settings.seo,
    siteName: site.name,
    baseTitle: page.title,
    routeKind: 'page',
    routePath: pageFrame.permalink,
    language: site.settings.language,
    interpolate: (pattern) => interpolateTokens(pattern, templateContext),
  })
  const jsonLd = buildJsonLdEntities(resolved, {
    kind: 'page',
    routePath: pageFrame.permalink,
    siteName: site.name,
    organization: site.settings.seo?.organization,
  })
  return { resolved, jsonLd }
}

export function buildDocumentMetaTags(site: SiteDocument, seo: PublishedSeo): DocumentMetaTags {
  const { settings } = site
  const { resolved, jsonLd } = seo

  const lines: string[] = []
  lines.push(`<title>${escapeHtml(resolved.title)}</title>`)
  if (resolved.description) {
    lines.push(`<meta name="description" content="${escapeHtml(resolved.description)}">`)
  }
  if (resolved.noindex) {
    lines.push('<meta name="robots" content="noindex">')
  }
  if (resolved.canonicalUrl && isSafeUrl(resolved.canonicalUrl)) {
    lines.push(`<link rel="canonical" href="${escapeHtml(resolved.canonicalUrl)}">`)
  }

  lines.push(`<meta property="og:title" content="${escapeHtml(resolved.ogTitle)}">`)
  if (resolved.ogDescription) {
    lines.push(`<meta property="og:description" content="${escapeHtml(resolved.ogDescription)}">`)
  }
  if (resolved.ogImage && isSafeUrl(resolved.ogImage)) {
    lines.push(`<meta property="og:image" content="${escapeHtml(resolved.ogImage)}">`)
    if (resolved.ogImageAlt) {
      lines.push(`<meta property="og:image:alt" content="${escapeHtml(resolved.ogImageAlt)}">`)
    }
  }
  lines.push(`<meta property="og:type" content="${escapeHtml(resolved.ogType)}">`)
  if (resolved.ogUrl && isSafeUrl(resolved.ogUrl)) {
    lines.push(`<meta property="og:url" content="${escapeHtml(resolved.ogUrl)}">`)
  }
  lines.push(`<meta property="og:site_name" content="${escapeHtml(site.name)}">`)
  if (resolved.ogLocale) {
    lines.push(`<meta property="og:locale" content="${escapeHtml(resolved.ogLocale)}">`)
  }
  if (resolved.ogType === 'article') {
    if (resolved.articlePublishedTime) {
      lines.push(`<meta property="article:published_time" content="${escapeHtml(resolved.articlePublishedTime)}">`)
    }
    if (resolved.articleModifiedTime) {
      lines.push(`<meta property="article:modified_time" content="${escapeHtml(resolved.articleModifiedTime)}">`)
    }
  }

  lines.push(`<meta name="twitter:card" content="${escapeHtml(resolved.xCard)}">`)
  if (resolved.xSiteHandle) {
    lines.push(`<meta name="twitter:site" content="${escapeHtml(resolved.xSiteHandle)}">`)
  }
  lines.push(`<meta name="twitter:title" content="${escapeHtml(resolved.xTitle)}">`)
  if (resolved.xDescription) {
    lines.push(`<meta name="twitter:description" content="${escapeHtml(resolved.xDescription)}">`)
  }
  if (resolved.xImage && isSafeUrl(resolved.xImage)) {
    lines.push(`<meta name="twitter:image" content="${escapeHtml(resolved.xImage)}">`)
    if (resolved.xImageAlt) {
      lines.push(`<meta name="twitter:image:alt" content="${escapeHtml(resolved.xImageAlt)}">`)
    }
  }

  for (const entity of jsonLd) {
    lines.push(`<script type="application/ld+json">${serializeJsonLd(entity)}</script>`)
  }

  const favicon =
    settings.faviconUrl && isSafeUrl(settings.faviconUrl)
      ? `\n  <link rel="icon" href="${escapeHtml(settings.faviconUrl)}">`
      : ''
  return {
    seoHeadHtml: lines.map((line) => `  ${line}`).join('\n'),
    favicon,
    langAttr: escapeHtml(settings.language ?? 'en'),
  }
}
