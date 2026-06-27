/**
 * SEO metadata schemas — the persisted shapes for per-target SEO data and
 * site-wide SEO defaults.
 *
 * `SeoMetadata` is the structured object stored in `cells_json.seo` on
 * `page` and `postType` rows (built-in `seoMetadata` field). `SiteSeoSettings`
 * lives under `site.settings.seo` and carries the site-wide defaults the
 * resolver (`./resolve.ts`) falls back to.
 *
 * Title/description values on entry-template rows may carry `{source.field}`
 * tokens from the shared token engine (`@core/templates` —
 * `tokenInterpolation.ts`); the resolver receives an `interpolate` closure so
 * this module stays decoupled from the templates engine.
 *
 * Pure leaf module: no imports from publisher, server, or admin code.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'

// ---------------------------------------------------------------------------
// SeoMetadata — per-target structured SEO object (cells_json.seo)
// ---------------------------------------------------------------------------

export const OgTypeSchema = Type.Union([
  Type.Literal('website'),
  Type.Literal('article'),
])

export type OgType = Static<typeof OgTypeSchema>

export const XCardTypeSchema = Type.Union([
  Type.Literal('summary'),
  Type.Literal('summary_large_image'),
])

export type XCardType = Static<typeof XCardTypeSchema>

export const SeoMetadataSchema = Type.Object({
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  canonicalUrl: Type.Optional(Type.String()),
  noindex: Type.Optional(Type.Boolean()),

  ogTitle: Type.Optional(Type.String()),
  ogDescription: Type.Optional(Type.String()),
  ogImage: Type.Optional(Type.String()),
  ogImageAlt: Type.Optional(Type.String()),
  ogType: Type.Optional(OgTypeSchema),

  xTitle: Type.Optional(Type.String()),
  xDescription: Type.Optional(Type.String()),
  xImage: Type.Optional(Type.String()),
  xImageAlt: Type.Optional(Type.String()),
  xCard: Type.Optional(XCardTypeSchema),
})

export type SeoMetadata = Static<typeof SeoMetadataSchema>

/**
 * Tolerant parse for `cells_json.seo` blobs read from storage. Returns
 * `undefined` for anything that isn't a valid SeoMetadata object — a corrupt
 * SEO cell must never prevent loading the row.
 */
export function parseSeoMetadata(raw: unknown): SeoMetadata | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return compiledCheck(SeoMetadataSchema, raw) ? (raw as SeoMetadata) : undefined
}

// ---------------------------------------------------------------------------
// SiteSeoSettings — site-wide defaults (site.settings.seo)
// ---------------------------------------------------------------------------

export const SeoOrganizationSchema = Type.Object({
  name: Type.Optional(Type.String()),
  logoUrl: Type.Optional(Type.String()),
})

export type SeoOrganization = Static<typeof SeoOrganizationSchema>

/**
 * robots.txt is edited as a single document: `content` is the raw body the
 * admin types in the Robots tab's code editor. Empty/absent ⇒ the served
 * file falls back to `DEFAULT_ROBOTS_TEMPLATE`. The server appends the
 * `Sitemap:` line (origin-resolved) at serve time unless the body already
 * has one — so the author never has to hardcode the production origin.
 */
export const SeoRobotsSettingsSchema = Type.Object({
  content: Type.Optional(Type.String()),
})

export type SeoRobotsSettings = Static<typeof SeoRobotsSettingsSchema>

export const SeoSitemapSettingsSchema = Type.Object({
  /** Defaults to true. */
  enabled: Type.Optional(Type.Boolean()),
  /** Target ids (`page:<rowId>` / `row:<rowId>`) excluded from the sitemap. */
  excludedTargets: Type.Optional(Type.Array(Type.String())),
})

export type SeoSitemapSettings = Static<typeof SeoSitemapSettingsSchema>

export const SiteSeoSettingsSchema = Type.Object({
  /** Site-wide title pattern, e.g. `'{page.title} — {site.name}'`. */
  titlePattern: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  defaultOgImage: Type.Optional(Type.String()),
  defaultOgImageAlt: Type.Optional(Type.String()),
  defaultXCard: Type.Optional(XCardTypeSchema),
  /** X account handle for `twitter:site`, with or without the leading `@`. */
  xSiteHandle: Type.Optional(Type.String()),
  organization: Type.Optional(SeoOrganizationSchema),
  robots: Type.Optional(SeoRobotsSettingsSchema),
  sitemap: Type.Optional(SeoSitemapSettingsSchema),
})

export type SiteSeoSettings = Static<typeof SiteSeoSettingsSchema>

/**
 * Tolerant parse for `site.settings.seo`. Invalid blobs become `undefined`
 * (site loads with no SEO defaults rather than failing).
 */
export function parseSiteSeoSettings(raw: unknown): SiteSeoSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return compiledCheck(SiteSeoSettingsSchema, raw) ? (raw as SiteSeoSettings) : undefined
}
