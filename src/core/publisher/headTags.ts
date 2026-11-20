/**
 * Document `<head>` metadata: the `<title>`, `lang`, and every tag a page's
 * SEO settings (`page.seo`, see `@core/page-tree` → `PageSeo`) ask for.
 *
 * Fallback chain, per value:
 *   - title       → caller's `documentMeta.title` (a post-type entry's SEO
 *                   title) → `page.seo.title` → `settings.metaTitle` →
 *                   `page.title` → `site.name`
 *   - description → `documentMeta.description` → `page.seo.description` →
 *                   `settings.metaDescription`
 *   - favicon     → `page.seo.favicon` → `settings.faviconUrl`
 * Every other tag is emitted only when the page sets it.
 *
 * Text values, URLs and JSON-LD string values are token-interpolated against
 * the render context before escaping, so a template page can write `{currentEntry.title} | Acme`
 * or a canonical of `https://acme.com{route.path}` once for every entry. The
 * fallback chain picks the raw value first; a token that resolves empty does
 * NOT re-trigger the fallback (authors use the token's own `{…|fallback}`).
 *
 * Safety: every attribute value goes through `escapeHtml`. URL-bearing values
 * must pass `isSafeUrl` (no `javascript:` / `data:` / custom schemes) or the
 * tag is dropped. JSON-LD is parsed and re-serialised, so only valid JSON is
 * emitted, with every `<` written as `<` — the block cannot close its
 * own `<script>` element. A `type="application/ld+json"` block is a data
 * block, never executed, so it needs no CSP `script-src` source.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import { hasDangerousUrlScheme } from '@core/html-sanitize'
import { escapeHtml, isSafeUrl } from './utils'

/**
 * `<head>` values supplied by the caller for this render only. An omitted
 * (or blank) key falls through to the page and site settings.
 */
export interface DocumentMetaOverride {
  title?: string
  description?: string
}

export interface DocumentHead {
  /** Escaped `<title>` text. */
  pageTitle: string
  /** Escaped `lang` attribute value. */
  langAttr: string
  /** Every tag after `<title>`, each on its own indented line, or ''. */
  tags: string
  /**
   * CSP sources the tags need beyond the base policy: the origin of an
   * external web manifest (`manifest-src`), which `default-src 'self'` would
   * otherwise block.
   */
  cspSources: Map<string, Set<string>>
}

export function buildDocumentHead(
  site: SiteDocument,
  page: Page,
  context: TemplateRenderDataContext,
  override: DocumentMetaOverride = {},
): DocumentHead {
  const { settings } = site
  const seo = page.seo ?? {}
  const text = (value: string) => interpolateTokens(value, context)
  const url = (value: string | undefined): string | null => {
    if (!value) return null
    const resolved = interpolateTokens(value, context).trim()
    return resolved && isSafeUrl(resolved) ? resolved : null
  }

  const lines: string[] = []
  const cspSources = new Map<string, Set<string>>()
  const meta = (attribute: 'name' | 'property', name: string, content: string | undefined) => {
    if (content === undefined || content === '') return
    lines.push(`<meta ${attribute}="${escapeHtml(name)}" content="${escapeHtml(content)}">`)
  }

  const description = override.description || seo.description || settings.metaDescription
  if (description) meta('name', 'description', text(description))

  const canonical = url(seo.canonical)
  if (canonical) lines.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`)
  if (seo.robots) meta('name', 'robots', seo.robots)
  if (seo.colorScheme) meta('name', 'color-scheme', seo.colorScheme)
  for (const theme of seo.themeColors ?? []) {
    const media = theme.media ? ` media="${escapeHtml(theme.media)}"` : ''
    lines.push(`<meta name="theme-color" content="${escapeHtml(theme.color)}"${media}>`)
  }

  const faviconHref = url(seo.favicon?.href ?? settings.faviconUrl)
  if (faviconHref) {
    const type = seo.favicon?.type ? ` type="${escapeHtml(seo.favicon.type)}"` : ''
    lines.push(`<link rel="icon" href="${escapeHtml(faviconHref)}"${type}>`)
  }

  for (const link of seo.links ?? []) {
    const href = url(link.href)
    if (!href) continue
    const attrs: string[] = [`rel="${escapeHtml(link.rel)}"`, `href="${escapeHtml(href)}"`]
    // `as` only means something on a preload; elsewhere it is noise.
    if (link.as && link.rel === 'preload') attrs.push(`as="${escapeHtml(link.as)}"`)
    for (const key of ['type', 'title', 'hreflang', 'media', 'sizes', 'crossorigin'] as const) {
      const value = link[key]
      if (value) attrs.push(`${key}="${escapeHtml(value)}"`)
    }
    lines.push(`<link ${attrs.join(' ')}>`)
    const manifestOrigin = link.rel === 'manifest' ? externalOrigin(href) : null
    if (manifestOrigin) {
      // Naming the directive replaces its `default-src` fallback, so 'self' stays listed.
      const sources = cspSources.get('manifest-src') ?? new Set<string>(["'self'"])
      sources.add(manifestOrigin)
      cspSources.set('manifest-src', sources)
    }
  }

  const og = seo.openGraph
  if (og) {
    meta('property', 'og:type', og.type)
    meta('property', 'og:site_name', og.siteName)
    meta('property', 'og:url', url(og.url) ?? undefined)
    meta('property', 'og:title', og.title ? text(og.title) : undefined)
    meta('property', 'og:description', og.description ? text(og.description) : undefined)
    meta('property', 'og:image', url(og.image) ?? undefined)
    meta('property', 'og:image:alt', og.imageAlt ? text(og.imageAlt) : undefined)
  }

  const twitter = seo.twitter
  if (twitter) {
    meta('name', 'twitter:card', twitter.card)
    meta('name', 'twitter:site', twitter.site)
    meta('name', 'twitter:creator', twitter.creator)
    meta('name', 'twitter:title', twitter.title ? text(twitter.title) : undefined)
    meta('name', 'twitter:description', twitter.description ? text(twitter.description) : undefined)
    meta('name', 'twitter:image', url(twitter.image) ?? undefined)
  }

  for (const extra of seo.meta ?? []) {
    if (hasDangerousUrlScheme(extra.content)) continue
    meta(extra.attribute, extra.name, extra.content)
  }

  for (const block of seo.jsonLd ?? []) {
    const json = serializeJsonLd(block, text)
    if (json) lines.push(`<script type="application/ld+json">${json}</script>`)
  }

  const title = override.title || seo.title || settings.metaTitle || page.title || site.name

  return {
    pageTitle: escapeHtml(text(title)),
    langAttr: escapeHtml(settings.language ?? 'en'),
    tags: lines.map((line) => `\n  ${line}`).join(''),
    cspSources,
  }
}

/** `https://cdn.example` for an absolute or protocol-relative URL, null for a same-origin one. */
function externalOrigin(href: string): string | null {
  if (!/^(https?:)?\/\//i.test(href)) return null
  try {
    return new URL(href, 'https://same-origin.invalid').origin
  } catch (_err) {
    // Unparseable: isSafeUrl already let it through as relative; nothing to allow.
    return null
  }
}

/**
 * Parse one JSON-LD block and re-serialise it compactly for a `<script>`
 * data block, or null when it is not a JSON object or array. `interpolate`
 * resolves template tokens inside string VALUES (never keys) after parsing,
 * so a token can never break the JSON. `<`, `>` and `&` are written as
 * Unicode escapes (valid inside JSON strings, identical once parsed), so no
 * `</script` or `<!--` sequence can survive into the HTML.
 */
export function serializeJsonLd(source: string, interpolate: (value: string) => string = (value) => value): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (_err) {
    // Not JSON: the editor flags it inline; the published page omits it.
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  return JSON.stringify(interpolateStrings(parsed, interpolate))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function interpolateStrings(value: unknown, interpolate: (value: string) => string): unknown {
  if (typeof value === 'string') return interpolate(value)
  if (Array.isArray(value)) return value.map((item) => interpolateStrings(item, interpolate))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateStrings(item, interpolate)]))
  }
  return value
}
