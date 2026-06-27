/**
 * SEO workspace API client — typed wrappers over `/admin/api/cms/seo/*`.
 *
 * All responses validate against TypeBox schemas via `apiRequest`
 * (`@core/http`); the SEO object shapes come straight from `@core/seo`, so
 * the admin client, the server handler, and the publisher share one source
 * of truth for the persisted shapes.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import { SeoMetadataSchema, SiteSeoSettingsSchema, type SeoMetadata, type SiteSeoSettings } from '@core/seo'

export const SeoTargetKindSchema = Type.Union([
  Type.Literal('page'),
  Type.Literal('template'),
  Type.Literal('post'),
])

export type SeoTargetKind = Static<typeof SeoTargetKindSchema>

export const SeoTargetSchema = Type.Object({
  kind: SeoTargetKindSchema,
  id: Type.String(),
  title: Type.String(),
  route: Type.Union([Type.String(), Type.Null()]),
  tableSlug: Type.Optional(Type.String()),
  tableLabel: Type.Optional(Type.String()),
  /** Templates only — the postType table slugs the template applies to. */
  templateTableSlugs: Type.Optional(Type.Array(Type.String())),
  seo: Type.Union([SeoMetadataSchema, Type.Null()]),
  status: Type.String(),
  updatedAt: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
})

export type SeoTarget = Static<typeof SeoTargetSchema>

export const SeoTargetsResponseSchema = Type.Object({
  siteName: Type.String(),
  language: Type.Union([Type.String(), Type.Null()]),
  publicOrigin: Type.Union([Type.String(), Type.Null()]),
  faviconUrl: Type.Union([Type.String(), Type.Null()]),
  siteSeo: Type.Union([SiteSeoSettingsSchema, Type.Null()]),
  targets: Type.Array(SeoTargetSchema),
})

export type SeoTargetsResponse = Static<typeof SeoTargetsResponseSchema>

const SeoTargetPutResponseSchema = Type.Object({
  target: SeoTargetSchema,
})

const SiteSeoPutResponseSchema = Type.Object({
  seo: Type.Union([SiteSeoSettingsSchema, Type.Null()]),
})

export async function fetchSeoTargets(signal?: AbortSignal): Promise<SeoTargetsResponse> {
  return apiRequest('/admin/api/cms/seo/targets', {
    schema: SeoTargetsResponseSchema,
    signal,
    fallbackMessage: 'Could not load SEO targets',
  })
}

export async function saveSeoTarget(
  kind: SeoTargetKind,
  id: string,
  seo: SeoMetadata,
): Promise<SeoTarget> {
  const result = await apiRequest(`/admin/api/cms/seo/targets/${kind}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { seo },
    schema: SeoTargetPutResponseSchema,
    fallbackMessage: 'Could not save SEO metadata',
  })
  return result.target
}

export async function saveSiteSeo(seo: SiteSeoSettings): Promise<SiteSeoSettings | null> {
  const result = await apiRequest('/admin/api/cms/seo/site', {
    method: 'PUT',
    body: { seo },
    schema: SiteSeoPutResponseSchema,
    fallbackMessage: 'Could not save site SEO settings',
  })
  return result.seo
}

const SeoSuggestionsResponseSchema = Type.Object({
  suggestions: Type.Array(Type.String()),
})

/**
 * One-shot AI metadata suggestions for a target field — returns 3 options.
 * `exclude` carries already-shown texts so "More options" regenerates fresh
 * ones instead of repeating.
 */
export async function generateSeoSuggestions(
  kind: SeoTargetKind,
  id: string,
  field: string,
  exclude: string[],
): Promise<string[]> {
  const result = await apiRequest('/admin/api/cms/seo/generate', {
    method: 'POST',
    body: { kind, id, field, exclude },
    schema: SeoSuggestionsResponseSchema,
    fallbackMessage: 'Could not generate suggestions',
  })
  return result.suggestions
}
