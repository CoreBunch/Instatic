import { assertSeoUrl, parsePageSeo, type Page, type SiteDocument } from '@core/page-tree'
import { urlScheme } from '@core/html-sanitize'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import { escapeHtml, isSafeUrl } from './utils'

/** Per-entry values override the template's authored document title/description. */
export interface DocumentMetaOverride {
  title?: string
  description?: string
}

function interpolateJson(value: unknown, context: TemplateRenderDataContext): unknown {
  if (typeof value === 'string') return interpolateTokens(value, context)
  if (Array.isArray(value)) return value.map((item) => interpolateJson(item, context))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateJson(item, context)]))
  }
  return value
}

/** One native metadata renderer is used by previews, static baking and live routes. */
export function buildDocumentMetaTags(
  site: SiteDocument,
  page: Page,
  context: TemplateRenderDataContext,
  override: DocumentMetaOverride = {},
) {
  const seo = parsePageSeo(page.seo)
  const resolve = (value: string) => interpolateTokens(value, context)
  const attribute = (value: string) => escapeHtml(resolve(value))
  const href = (value: string, path: string) => {
    const resolved = resolve(value)
    assertSeoUrl(resolved, path, false)
    return escapeHtml(resolved)
  }
  const description = override.description || seo?.description || site.settings.metaDescription
  const metaDesc = description ? `\n  <meta name="description" content="${attribute(description)}">` : ''
  const favicon = !seo?.links?.some((link) => link.rel === 'icon')
    && site.settings.faviconUrl && isSafeUrl(site.settings.faviconUrl)
    ? `\n  <link rel="icon" href="${escapeHtml(site.settings.faviconUrl)}">` : ''
  let pageMeta = ''
  const cspSources = new Map<string, Set<string>>()
  if (seo?.canonical) pageMeta += `\n  <link rel="canonical" href="${href(seo.canonical, 'seo.canonical')}">`
  for (const [index, alternate] of (seo?.alternates ?? []).entries()) {
    pageMeta += `\n  <link rel="alternate" hreflang="${escapeHtml(alternate.language)}" href="${href(alternate.href, `seo.alternates[${index}].href`)}">`
  }
  for (const meta of seo?.meta ?? []) {
    pageMeta += `\n  <meta ${meta.attribute}="${escapeHtml(meta.key)}" content="${attribute(meta.content)}"${meta.media !== undefined ? ` media="${attribute(meta.media)}"` : ''}>`
  }
  for (const [index, link] of (seo?.links ?? []).entries()) {
    const resolvedHref = href(link.href, `seo.links[${index}].href`)
    pageMeta += `\n  <link rel="${link.rel}" href="${resolvedHref}"`
      + (['type', 'sizes', 'media'] as const).map((key) => link[key] !== undefined ? ` ${key}="${attribute(link[key])}"` : '').join('') + '>'
    if (link.rel === 'manifest') {
      const rawHref = resolve(link.href)
      const source = urlScheme(rawHref) !== null ? new URL(rawHref).origin
        : rawHref.trimStart().startsWith('//') ? new URL(rawHref, 'https://instatic.invalid').host : "'self'"
      const sources = cspSources.get('manifest-src') ?? new Set<string>()
      sources.add(source)
      cspSources.set('manifest-src', sources)
    }
  }
  for (const data of seo?.structuredData ?? []) {
    // Escaping '<' makes closing script tags and HTML comment openers inert while
    // JSON.parse restores the original data. JSON-LD never grants executable CSP sources.
    const json = JSON.stringify(interpolateJson(data, context)).replace(/</g, '\\u003c')
    pageMeta += `\n  <script type="application/ld+json">${json}</script>`
  }
  return {
    pageTitle: attribute(override.title || seo?.title || site.settings.metaTitle || page.title || site.name),
    metaDesc,
    favicon,
    pageMeta,
    cspSources,
    langAttr: escapeHtml(context.site?.language ?? page.language ?? site.settings.language ?? 'en'),
  }
}
