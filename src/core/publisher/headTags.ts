/**
 * Document `<head>` metadata: the `<title>`, `lang`, and every tag a page's
 * SEO settings (`page.seo`, see `@core/page-tree` → `PageSeo`) ask for.
 *
 * Head fields inherit from global settings through the matching template
 * chain to the page. The site's meta title, description and favicon remain
 * the defaults when no SEO layer sets those fields.
 * On an entry route:
 *   - the entry's own SEO title / description (`documentMeta`) outrank the
 *     template's;
 *   - a template canonical with no token would point every entry at one URL,
 *     so it becomes the entry's own permalink (on the canonical's origin when
 *     that is absolute); one with a token resolves per
 *     entry. A token-less `og:url` is omitted for the same reason;
 *   - everything else (robots included, so a `noindex` template hides every
 *     entry) applies to all entries as written.
 *
 * Text values, URLs and JSON-LD string values are token-interpolated against
 * the render context (without `{route.query.*}` and `{member.*}`, see below)
 * before escaping, so a template page can write `{currentEntry.title} | Acme`
 * or a canonical of `https://acme.com{route.path}` once for every entry. The
 * fallback chain picks the raw value first; a token that resolves empty does
 * NOT re-trigger the fallback (authors use the token's own `{…|fallback}`).
 *
 * A URL holding a `cms:page:<id>` reference (an imported page's link to
 * another imported page) resolves to that page's current path, like body
 * links do.
 *
 * Safety: every attribute value goes through `escapeHtml`. URL-bearing values
 * must pass `isSafeUrl` (no `javascript:` / `data:` / custom schemes) or the
 * tag is dropped. JSON-LD is parsed and re-serialised, so only valid JSON is
 * emitted, with every `<` written as `<` — the block cannot close its
 * own `<script>` element. A `type="application/ld+json"` block is a data
 * block, never executed, so it needs no CSP `script-src` source.
 */

import { mergePageSeo, resolvePageRef, type Page, type SiteDocument } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { containsTokens, interpolateTokens } from '@core/templates/tokenInterpolation'
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
  const seo = mergePageSeo(settings.seo, page.seo) ?? {}
  // `<head>` is never a hole: it is cached with the page under the path and
  // the canonical query. A token reading the raw query string or the visitor
  // would bake one request's value into every later response, so those frames
  // are left out here and such tokens resolve empty (or to their |fallback).
  const headContext: TemplateRenderDataContext = {
    ...context,
    ...(context.route ? { route: { ...context.route, query: {} } } : {}),
    member: undefined,
  }
  const text = (value: string) => interpolateTokens(value, headContext)
  const optionalText = (value: string | undefined) => value ? text(value) : undefined
  const url = (value: string | undefined): string | null => {
    if (!value) return null
    // A `cms:page:<id>` reference (an imported page link) names the target
    // page's current path; a page that no longer exists drops the tag.
    const pagePath = resolvePageRef(value, site.pages)
    if (pagePath !== null) return pagePath === '#' ? null : pagePath
    const resolved = interpolateTokens(value, headContext).trim()
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

  // The entry this document renders, on an entry route (see the header).
  const entry = headContext.entryStack.at(-1)
  const entryPermalink = typeof entry?.fields.permalink === 'string' ? entry.fields.permalink : undefined
  const perEntry = (value: string | undefined) =>
    entry && value && !containsTokens(value) ? undefined : value

  const canonical = url(entry && seo.canonical && !containsTokens(seo.canonical)
    ? entryCanonical(entryPermalink, seo.canonical)
    : seo.canonical)
  if (canonical) lines.push(`<link rel="canonical" href="${escapeHtml(canonical)}">`)
  if (seo.robots) meta('name', 'robots', optionalText(seo.robots))
  if (seo.colorScheme) meta('name', 'color-scheme', optionalText(seo.colorScheme))
  for (const theme of seo.themeColors ?? []) {
    const media = theme.media ? ` media="${escapeHtml(text(theme.media))}"` : ''
    lines.push(`<meta name="theme-color" content="${escapeHtml(text(theme.color))}"${media}>`)
  }

  // A page that lists its own icon links (sizes / media variants) has its icon
  // set; the site favicon would add a second, competing one.
  const pageListsIcons = (seo.links ?? []).some((link) => link.rel === 'icon')
  const faviconHref = url(seo.favicon?.href ?? (pageListsIcons ? undefined : settings.faviconUrl))
  if (faviconHref) {
    const type = seo.favicon?.type ? ` type="${escapeHtml(text(seo.favicon.type))}"` : ''
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
      if (value) attrs.push(`${key}="${escapeHtml(text(value))}"`)
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
    meta('property', 'og:type', optionalText(og.type))
    meta('property', 'og:site_name', optionalText(og.siteName))
    meta('property', 'og:url', url(perEntry(og.url)) ?? undefined)
    meta('property', 'og:title', og.title ? text(og.title) : undefined)
    meta('property', 'og:description', og.description ? text(og.description) : undefined)
    meta('property', 'og:image', url(og.image) ?? undefined)
    meta('property', 'og:image:alt', og.imageAlt ? text(og.imageAlt) : undefined)
  }

  const twitter = seo.twitter
  if (twitter) {
    meta('name', 'twitter:card', optionalText(twitter.card))
    meta('name', 'twitter:site', optionalText(twitter.site))
    meta('name', 'twitter:creator', optionalText(twitter.creator))
    meta('name', 'twitter:title', twitter.title ? text(twitter.title) : undefined)
    meta('name', 'twitter:description', twitter.description ? text(twitter.description) : undefined)
    meta('name', 'twitter:image', url(twitter.image) ?? undefined)
  }

  for (const extra of seo.meta ?? []) {
    const content = text(extra.content)
    if (hasDangerousUrlScheme(content)) continue
    meta(extra.attribute, extra.name, content)
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

/**
 * The canonical of one entry under a token-less template canonical: the
 * entry's permalink, on the template canonical's origin when that is
 * absolute (`https://acme.com/posts` → `https://acme.com/posts/hello`).
 */
function entryCanonical(permalink: string | undefined, templateCanonical: string): string | undefined {
  if (!permalink) return undefined
  if (!/^https?:\/\//i.test(templateCanonical)) return permalink
  try {
    return new URL(permalink, templateCanonical).toString()
  } catch (_err) {
    // An unparseable template canonical: the relative permalink is still right.
    return permalink
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
