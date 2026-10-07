import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import { urlScheme } from '@core/html-sanitize'

/** JSON-LD is data, never executable JavaScript or an authored HTML fragment. */
const SeoJsonValueSchema = Type.Recursive((Self) => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), Type.String(),
  Type.Array(Self), Type.Record(Type.String(), Self),
]), { $id: 'SeoJsonValue' })

// JSON-LD is an open vocabulary. Keep the domain type shallow, like other
// arbitrary data cells; the recursive schema validates its values at the boundary.
export const SeoStructuredDataSchema = Type.Array(Type.Record(Type.String(), Type.Unknown()))
const nonEmpty = Type.String({ minLength: 1 })

export const SeoAlternateSchema = Type.Object({
  id: nonEmpty,
  language: nonEmpty,
  href: nonEmpty,
}, { additionalProperties: false })

export const SeoMetaSchema = Type.Object({
  id: nonEmpty,
  attribute: Type.Union([Type.Literal('name'), Type.Literal('property'), Type.Literal('http-equiv')]),
  key: nonEmpty,
  content: Type.String(),
  media: Type.Optional(Type.String()),
}, { additionalProperties: false })

/** Head metadata links do not load styles or executable resources. */
export const SEO_LINK_RELATIONS = [
  'author', 'icon', 'apple-touch-icon', 'manifest', 'license', 'help', 'me', 'search', 'prev', 'next',
] as const
export const SeoLinkSchema = Type.Object({
  id: nonEmpty,
  rel: Type.Union(SEO_LINK_RELATIONS.map((rel) => Type.Literal(rel))),
  href: nonEmpty,
  type: Type.Optional(Type.String()),
  sizes: Type.Optional(Type.String()),
  media: Type.Optional(Type.String()),
}, { additionalProperties: false })

export const PageSeoSchema = Type.Object({
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  canonical: Type.Optional(nonEmpty),
  alternates: Type.Optional(Type.Array(SeoAlternateSchema)),
  meta: Type.Optional(Type.Array(SeoMetaSchema)),
  links: Type.Optional(Type.Array(SeoLinkSchema)),
  structuredData: Type.Optional(SeoStructuredDataSchema),
}, { additionalProperties: false })

export type PageSeo = Static<typeof PageSeoSchema>
export type SeoAlternate = Static<typeof SeoAlternateSchema>
export type SeoMeta = Static<typeof SeoMetaSchema>
export type SeoLink = Static<typeof SeoLinkSchema>

export class PageSeoValidationError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.path = path
    this.name = 'PageSeoValidationError'
  }
}

/** Authored URLs can contain native tokens; resolved URLs are checked again at publish. */
export function assertSeoUrl(value: string, path: string, allowBindings = true): void {
  const literal = allowBindings ? value.replace(/\{(?:page|site|route|currentEntry)\.[^{}]+\}/g, 'binding') : value
  const scheme = urlScheme(literal)
  if (!value.trim() || (scheme !== null && !['http:', 'https:'].includes(scheme))) {
    throw new PageSeoValidationError(path, 'Expected a safe HTTP(S) or relative URL')
  }
  try {
    new URL(literal, 'https://instatic.invalid')
  } catch {
    throw new PageSeoValidationError(path, 'Expected a valid URL')
  }
}

/** Required metadata is never silently discarded when its stored shape is invalid. */
export function parsePageSeo(raw: unknown, path = 'seo'): PageSeo | undefined {
  if (raw === undefined) return undefined
  const result = safeParseValue(PageSeoSchema, raw)
  if (!result.ok) {
    const error = result.errors[0]
    throw new PageSeoValidationError(`${path}${error?.path ?? ''}`, error?.message ?? 'Invalid page metadata')
  }
  const seo = result.value
  for (const [index, value] of (seo.structuredData ?? []).entries()) {
    const json = safeParseValue(SeoJsonValueSchema, value)
    if (!json.ok) throw new PageSeoValidationError(`${path}.structuredData[${index}]`, 'Expected JSON values')
  }
  if (seo.canonical) assertSeoUrl(seo.canonical, `${path}.canonical`)
  for (const [index, alternate] of (seo.alternates ?? []).entries()) {
    if (!/^(?:x-default|[a-z]{2,8}(?:-[a-z0-9]{1,8})*)$/i.test(alternate.language)) {
      throw new PageSeoValidationError(`${path}.alternates[${index}].language`, 'Expected a language tag or x-default')
    }
    assertSeoUrl(alternate.href, `${path}.alternates[${index}].href`)
  }
  for (const [index, meta] of (seo.meta ?? []).entries()) {
    const key = meta.key.toLowerCase()
    if ((meta.attribute === 'name' && ['description', 'viewport', 'charset'].includes(key))
      || (meta.attribute === 'http-equiv' && !['content-language', 'default-style', 'x-ua-compatible'].includes(key))) {
      throw new PageSeoValidationError(`${path}.meta[${index}].key`, 'This metadata is owned by the publisher or is not a passive document pragma')
    }
  }
  for (const [index, link] of (seo.links ?? []).entries()) assertSeoUrl(link.href, `${path}.links[${index}].href`)
  for (const key of ['alternates', 'meta', 'links'] as const) {
    const ids = (seo[key] ?? []).map((entry) => entry.id)
    if (new Set(ids).size !== ids.length) throw new PageSeoValidationError(`${path}.${key}`, 'Item IDs must be unique')
  }
  return Object.keys(seo).length ? seo : undefined
}
