/**
 * headSeo — read an imported HTML document's `<head>` into the page's SEO
 * settings (`PageSeo`, see `@core/page-tree`).
 *
 * The `<title>` is not read here: it becomes the page title in
 * `htmlPagePlan`. Stylesheets and scripts have their own pipelines. Everything
 * else a static site puts in its head maps onto a structured `PageSeo` field
 * or one of its allowlisted extra `meta` / `links` entries:
 *
 *   meta description / robots / theme-color / color-scheme → own fields
 *   meta og:* (property or name)                           → openGraph, else extra meta
 *   meta twitter:*                                         → twitter, else extra meta
 *   other named meta                                       → extra meta
 *   link canonical                                         → canonical
 *   first link icon                                        → favicon (others → links)
 *   link alternate / preload / preconnect / manifest / …   → links
 *   script type=application/ld+json (head or body)         → jsonLd
 *
 * A tag that cannot be kept (`http-equiv`, `modulepreload`, a preload of a
 * script, an unknown `rel`, JSON-LD that is not JSON) is reported as a
 * `head-tag-dropped` warning — never dropped silently.
 *
 * `extractHeadSeo` returns URLs exactly as authored. `buildAssetPlan` then
 * runs `normalizeHeadSeoUrls`, which resolves the file ones against the
 * page's path and plans them for upload; `applyAssetRewrites` swaps in the
 * uploaded media URL.
 */

import {
  PAGE_HEAD_LINK_RELS,
  PAGE_HEAD_PRELOAD_AS,
  RESERVED_PAGE_META_NAMES,
  parsePageSeo,
  type PageHeadLink,
  type PageHeadLinkRel,
  type PageHeadMeta,
  type PageHeadPreloadAs,
  type PageOpenGraph,
  type PageSeo,
  type PageTwitterCard,
} from '@core/page-tree'
import { parseHtml } from '@core/htmlImport'
import { canonicalJson } from '@core/utils/canonicalJson'
import type { ImportWarning } from './warnings'
import { EXTERNAL_URL_RE, resolveAndRecord, resolveRelativePath, type AssetResolver } from './assetResolver'
import { guessMimeType, isImportUploadableMimeType } from './mimeTypes'

interface HeadSeoResult {
  seo: PageSeo | null
  warnings: ImportWarning[]
}

const OPEN_GRAPH_FIELDS: Record<string, keyof PageOpenGraph> = {
  'og:type': 'type',
  'og:url': 'url',
  'og:site_name': 'siteName',
  'og:title': 'title',
  'og:description': 'description',
  'og:image': 'image',
  'og:image:url': 'image',
  'og:image:alt': 'imageAlt',
}

const TWITTER_FIELDS: Record<string, keyof PageTwitterCard> = {
  'twitter:card': 'card',
  'twitter:site': 'site',
  'twitter:creator': 'creator',
  'twitter:title': 'title',
  'twitter:description': 'description',
  'twitter:image': 'image',
}

/** `http-equiv` values that only restate what the document already says. */
const REDUNDANT_HTTP_EQUIV = new Set(['content-type', 'x-ua-compatible'])

const META_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

const LINK_RELS: ReadonlySet<string> = new Set(PAGE_HEAD_LINK_RELS)
const PRELOAD_AS: ReadonlySet<string> = new Set(PAGE_HEAD_PRELOAD_AS)

/**
 * Extract the SEO settings of one imported HTML page.
 *
 * @param htmlSource — the full HTML document.
 * @param htmlPath   — its FileMap key, named in warnings.
 */
export function extractHeadSeo(htmlSource: string, htmlPath: string): HeadSeoResult {
  const doc = parseHtml(htmlSource)
  const warnings: ImportWarning[] = []
  const drop = (tag: string, reason: string) => {
    warnings.push({
      kind: 'head-tag-dropped',
      message: `${tag} in the head of "${htmlPath}" was not imported: ${reason}`,
      source: htmlPath,
    })
  }

  const seo: PageSeo = {}
  const openGraph: PageOpenGraph = {}
  const twitter: PageTwitterCard = {}
  const themeColors: NonNullable<PageSeo['themeColors']> = []
  const meta: PageHeadMeta[] = []
  const links: PageHeadLink[] = []
  const jsonLd: string[] = []

  for (const el of Array.from(doc.querySelectorAll('head meta'))) {
    if (el.hasAttribute('charset')) continue
    const content = el.getAttribute('content')?.trim() ?? ''

    const httpEquiv = el.getAttribute('http-equiv')?.trim().toLowerCase()
    if (httpEquiv) {
      if (!REDUNDANT_HTTP_EQUIV.has(httpEquiv)) {
        drop(`<meta http-equiv="${httpEquiv}">`, 'http-equiv tags change how the browser treats the page, so pages cannot set them')
      }
      continue
    }

    const property = el.getAttribute('property')?.trim()
    const nameAttr = el.getAttribute('name')?.trim()
    const name = property || nameAttr
    if (!name || !content) continue
    const key = name.toLowerCase()

    if (key === 'viewport') continue
    if (key === 'description') { seo.description ??= content; continue }
    if (key === 'robots') { seo.robots ??= content; continue }
    if (key === 'color-scheme') { seo.colorScheme ??= content; continue }
    if (key === 'theme-color') {
      const media = el.getAttribute('media')?.trim()
      themeColors.push({ color: content, ...(media ? { media } : {}) })
      continue
    }
    const ogField = OPEN_GRAPH_FIELDS[key]
    if (ogField) { openGraph[ogField] ??= content; continue }
    const twitterField = TWITTER_FIELDS[key]
    if (twitterField) { twitter[twitterField] ??= content; continue }

    if (!META_NAME_RE.test(name) || RESERVED_PAGE_META_NAMES.has(key)) {
      drop(`<meta ${property ? 'property' : 'name'}="${name}">`, 'the name is not one a page can set')
      continue
    }
    meta.push({ attribute: property ? 'property' : 'name', name, content })
  }

  for (const el of Array.from(doc.querySelectorAll('head link'))) {
    const rels = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const href = el.getAttribute('href')?.trim()
    if (rels.includes('stylesheet') || !href) continue

    if (rels.includes('canonical')) { seo.canonical ??= href; continue }

    if (rels.includes('icon') && !seo.favicon && !el.hasAttribute('media') && !el.hasAttribute('sizes')) {
      const type = el.getAttribute('type')?.trim()
      seo.favicon = { href, ...(type ? { type } : {}) }
      continue
    }

    // `shortcut icon` is the legacy spelling of `icon`.
    const rel = rels.includes('icon') ? 'icon' : rels.find((candidate) => LINK_RELS.has(candidate))
    if (!rel) {
      drop(`<link rel="${rels.join(' ')}">`, rels.includes('modulepreload')
        ? 'pages cannot preload scripts'
        : 'that link type is not one a page can set')
      continue
    }
    const link = readLink(el, rel as PageHeadLinkRel, href)
    if (!link) {
      drop(`<link rel="preload" as="${el.getAttribute('as') ?? ''}">`, 'pages can preload fonts, images, styles, media and data, not scripts')
      continue
    }
    links.push(link)
  }

  for (const el of Array.from(doc.querySelectorAll('script[type]'))) {
    if (el.getAttribute('type')?.trim().toLowerCase() !== 'application/ld+json') continue
    const text = el.textContent?.trim() ?? ''
    if (!text) continue
    try {
      JSON.parse(text)
      jsonLd.push(text)
    } catch (_err) {
      // Reported, not thrown: one broken block must not stop the import.
      drop('A <script type="application/ld+json"> block', 'its text is not valid JSON')
    }
  }

  if (themeColors.length > 0) seo.themeColors = themeColors
  if (Object.keys(openGraph).length > 0) seo.openGraph = openGraph
  if (Object.keys(twitter).length > 0) seo.twitter = twitter
  if (meta.length > 0) seo.meta = meta
  if (links.length > 0) seo.links = links
  if (jsonLd.length > 0) seo.jsonLd = jsonLd

  // The schema caps lengths and counts; anything past them is reported.
  const parsed = parsePageSeo(seo)
  if (canonicalJson(parsed ?? {}) !== canonicalJson(seo)) {
    drop('Some head tags', 'they exceed the length or count a page setting can hold')
  }
  return { seo: parsed, warnings }
}

function readLink(el: Element, rel: PageHeadLinkRel, href: string): PageHeadLink | null {
  const link: PageHeadLink = { rel, href }
  if (rel === 'preload') {
    const as = el.getAttribute('as')?.trim().toLowerCase() ?? ''
    if (!PRELOAD_AS.has(as)) return null
    link.as = as as PageHeadPreloadAs
  }
  for (const key of ['type', 'title', 'hreflang', 'media', 'sizes'] as const) {
    const value = el.getAttribute(key)?.trim()
    if (value) link[key] = value
  }
  if (el.hasAttribute('crossorigin')) {
    link.crossorigin = el.getAttribute('crossorigin')?.trim().toLowerCase() === 'use-credentials'
      ? 'use-credentials'
      : 'anonymous'
  }
  return link
}

// ---------------------------------------------------------------------------
// File URLs (run by buildAssetPlan)
// ---------------------------------------------------------------------------

/**
 * Normalise the file URLs in a page's head settings: the favicon, the Open
 * Graph / Twitter images, and every extra link that points at a file.
 *
 * A file the media library can store becomes its FileMap key (uploaded, then
 * rewritten to the media URL by `applyAssetRewrites`). A file in the archive
 * the media library cannot store (`llms.txt`, a web manifest, a stylesheet)
 * keeps its link, re-pointed at the file's root-relative path so it means the
 * same on every page, and reports `head-file-not-hosted` (as does a non-media
 * file the archive does not contain). A URL naming another imported page is
 * left for `rewriteInternalLinks`, which turns it into a `cms:page:<id>`
 * reference at commit. External URLs and origins (`preconnect`,
 * `dns-prefetch`) pass through as authored.
 */
export function normalizeHeadSeoUrls(seo: PageSeo | null, htmlFilePath: string, resolver: AssetResolver): PageSeo | null {
  if (!seo) return null
  const file = (href: string) => normalizeHeadFileUrl(href, htmlFilePath, resolver)
  const openGraph = seo.openGraph && {
    ...seo.openGraph,
    ...(seo.openGraph.image ? { image: file(seo.openGraph.image) } : {}),
  }
  return {
    ...seo,
    ...(seo.favicon ? { favicon: { ...seo.favicon, href: file(seo.favicon.href) } } : {}),
    ...(openGraph ? { openGraph } : {}),
    ...(seo.twitter?.image ? { twitter: { ...seo.twitter, image: file(seo.twitter.image) } } : {}),
    ...(seo.links
      ? {
          links: seo.links.map((link) =>
            link.rel === 'preconnect' || link.rel === 'dns-prefetch' ? link : { ...link, href: file(link.href) },
          ),
        }
      : {}),
  }
}

function normalizeHeadFileUrl(rawUrl: string, htmlFilePath: string, resolver: AssetResolver): string {
  if (EXTERNAL_URL_RE.test(rawUrl)) return rawUrl
  const fileMapKey = resolveAndRecord(rawUrl, htmlFilePath, resolver)
  if (fileMapKey) return fileMapKey

  const resolvedPath = resolveRelativePath(rawUrl, htmlFilePath)
  if (!resolvedPath) return rawUrl
  const entry = resolver.fileMap.files[resolvedPath]
  const mimeType = entry?.mimeType || guessMimeType(resolvedPath)
  // Another imported page: `rewriteInternalLinks` turns it into a page reference.
  if (entry && mimeType.toLowerCase().startsWith('text/html')) return rawUrl
  // A missing media file was already reported as `unresolved-asset`.
  if (entry || !isImportUploadableMimeType(mimeType)) {
    const reason = entry ? 'is not a file the media library can store' : 'is not in the import'
    resolver.warnings.push({
      kind: 'head-file-not-hosted',
      message: `"${resolvedPath}", linked from the head of "${htmlFilePath}", ${reason}. The link now points at "/${resolvedPath}": serve the file at that path, or change the link in the page's settings.`,
      source: htmlFilePath,
      path: resolvedPath,
    })
  }
  return `/${resolvedPath}`
}
