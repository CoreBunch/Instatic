/**
 * SEO metadata resolver — the single fallback engine shared by the
 * publisher (published `<head>` output), the admin SEO workspace (preview
 * placeholders + health indicators), and the server SEO endpoints.
 *
 * Title resolution is TWO-STAGE — literals resolve first, then a pattern
 * (if any) interpolates around the resolved base:
 *
 *   1. `baseTitle = target.title ?? input.baseTitle` (row/page display title)
 *   2. explicit `target.title` wins as-is (the user overriding the pattern);
 *      otherwise `templateSeo.title ?? siteSeo.titlePattern` is treated as a
 *      token pattern and interpolated via the provided `interpolate` closure
 *      (the shared `{source.field}` engine from `@core/templates`).
 *
 * Patterns and literal values never share a `??` chain.
 *
 * Absolute URLs (canonical, og:url) require `origin`; when absent they are
 * OMITTED — the publisher must never bake a guessed host into static HTML.
 */

import type { OgType, SeoMetadata, SiteSeoSettings, XCardType } from './schema'

export interface ResolveSeoInput {
  /** The target's own `cells_json.seo` (page or row). */
  target?: SeoMetadata
  /**
   * SEO object from the entry-template page row wrapping this target.
   * `title` / `description` may carry `{source.field}` tokens.
   */
  templateSeo?: SeoMetadata
  /** Site-wide defaults from `site.settings.seo`. */
  siteSeo?: SiteSeoSettings
  siteName: string
  /** Row/page display title — stage-1 fallback for the SEO title. */
  baseTitle?: string
  routeKind: 'page' | 'row'
  /** Public route path, e.g. `/` or `/posts/hello`. */
  routePath: string
  /** Absolute public origin (`https://example.com`). Absent ⇒ omit absolute URLs. */
  origin?: string
  /** Site language (BCP-47), drives `og:locale`. */
  language?: string
  /** ISO datetime — row publish time (article:published_time). */
  publishedAt?: string
  /** ISO datetime — row update time (article:modified_time, lastmod). */
  updatedAt?: string
  /**
   * Token interpolation closure — `interpolateTokens(pattern, context)`
   * partially applied over the render's TemplateRenderDataContext.
   * Defaults to identity (patterns emit verbatim), which admin previews
   * override with a synthetic context.
   */
  interpolate?: (pattern: string) => string
}

export interface ResolvedSeoMetadata {
  title: string
  description?: string
  canonicalUrl?: string
  noindex: boolean
  ogTitle: string
  ogDescription?: string
  ogImage?: string
  ogImageAlt?: string
  ogType: OgType
  ogUrl?: string
  ogLocale?: string
  xCard: XCardType
  xTitle: string
  xDescription?: string
  xImage?: string
  xImageAlt?: string
  /** `twitter:site` handle, normalised to include the leading `@`. */
  xSiteHandle?: string
  articlePublishedTime?: string
  articleModifiedTime?: string
}

/** Allow only http(s) absolute URLs for user-provided canonicals. */
export function isSafeCanonicalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** `en` → `en`, `en-US` → `en_US`, `cs` → `cs`. Invalid tags ⇒ undefined. */
function ogLocaleFromLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined
  const match = language.trim().match(/^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2}))?/)
  if (!match) return undefined
  const lang = match[1]!.toLowerCase()
  return match[2] ? `${lang}_${match[2].toUpperCase()}` : lang
}

function normalizeXHandle(handle: string | undefined): string | undefined {
  if (!handle) return undefined
  const trimmed = handle.trim()
  if (trimmed === '' || trimmed === '@') return undefined
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

/** Join origin + path without double slashes. */
export function absoluteUrl(origin: string, routePath: string): string {
  const base = origin.replace(/\/+$/, '')
  const path = routePath.startsWith('/') ? routePath : `/${routePath}`
  return `${base}${path}`
}

export function resolveSeoMetadata(input: ResolveSeoInput): ResolvedSeoMetadata {
  const target = input.target ?? {}
  const templateSeo = input.templateSeo ?? {}
  const siteSeo = input.siteSeo ?? {}
  const interpolate = input.interpolate ?? ((pattern: string) => pattern)

  // ── Title: two-stage ──────────────────────────────────────────────────────
  // Explicit per-target title wins as-is — the user overriding the pattern.
  const pattern = templateSeo.title ?? siteSeo.titlePattern
  let title: string
  if (target.title !== undefined && target.title !== '') {
    title = target.title
  } else if (pattern !== undefined && pattern !== '') {
    title = interpolate(pattern)
  } else {
    title = input.baseTitle !== undefined && input.baseTitle !== '' ? input.baseTitle : input.siteName
  }

  // Description: per-target → template (interpolated) → site default.
  const templateDescription =
    templateSeo.description !== undefined && templateSeo.description !== ''
      ? interpolate(templateSeo.description)
      : undefined
  const description = firstNonEmpty(target.description, templateDescription, siteSeo.description)

  // Canonical: explicit (validated) → origin + route path → omitted.
  let canonicalUrl: string | undefined
  if (target.canonicalUrl !== undefined && isSafeCanonicalUrl(target.canonicalUrl)) {
    canonicalUrl = target.canonicalUrl
  } else if (input.origin) {
    canonicalUrl = absoluteUrl(input.origin, input.routePath)
  }

  const ogTitle = firstNonEmpty(target.ogTitle) ?? title
  const ogDescription = firstNonEmpty(target.ogDescription) ?? description
  const ogImage = firstNonEmpty(target.ogImage, siteSeo.defaultOgImage)
  const ogImageAlt = firstNonEmpty(target.ogImageAlt, siteSeo.defaultOgImageAlt)
  const ogType: OgType = target.ogType ?? (input.routeKind === 'row' ? 'article' : 'website')

  const xTitle = firstNonEmpty(target.xTitle) ?? ogTitle
  const xDescription = firstNonEmpty(target.xDescription) ?? ogDescription
  const xImage = firstNonEmpty(target.xImage) ?? ogImage
  const xImageAlt = firstNonEmpty(target.xImageAlt) ?? ogImageAlt
  const xCard: XCardType =
    target.xCard ?? siteSeo.defaultXCard ?? (xImage ? 'summary_large_image' : 'summary')

  const isArticle = ogType === 'article'

  return {
    title,
    ...(description !== undefined ? { description } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    noindex: target.noindex === true,
    ogTitle,
    ...(ogDescription !== undefined ? { ogDescription } : {}),
    ...(ogImage !== undefined ? { ogImage } : {}),
    ...(ogImageAlt !== undefined ? { ogImageAlt } : {}),
    ogType,
    ...(canonicalUrl !== undefined ? { ogUrl: canonicalUrl } : {}),
    ...(ogLocaleFromLanguage(input.language) !== undefined
      ? { ogLocale: ogLocaleFromLanguage(input.language) }
      : {}),
    xCard,
    xTitle,
    ...(xDescription !== undefined ? { xDescription } : {}),
    ...(xImage !== undefined ? { xImage } : {}),
    ...(xImageAlt !== undefined ? { xImageAlt } : {}),
    ...(normalizeXHandle(siteSeo.xSiteHandle) !== undefined
      ? { xSiteHandle: normalizeXHandle(siteSeo.xSiteHandle) }
      : {}),
    ...(isArticle && input.publishedAt !== undefined
      ? { articlePublishedTime: input.publishedAt }
      : {}),
    ...(isArticle && input.updatedAt !== undefined
      ? { articleModifiedTime: input.updatedAt }
      : {}),
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}
