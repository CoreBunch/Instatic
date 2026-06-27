/**
 * First-party `GET /robots.txt` and `GET /sitemap.xml`.
 *
 * Both are generated from the PUBLISHED snapshot (SEO follows the publish
 * lifecycle — draft edits appear after the next publish) and cached keyed by
 * `publishVersion`, the same invalidation discipline as the Layer B render
 * cache: first request after a publish regenerates, `bumpPublishVersion()`
 * turns the cached body stale.
 *
 * Origin resolution: the configured canonical public origin wins; these
 * endpoints are dynamic (never baked to disk), so with nothing configured
 * they fall back to the request origin. Because the body embeds the origin,
 * the cache only serves a hit when the origin matches the cached one.
 *
 * Dispatched by `server/router.ts` BEFORE static assets and public page
 * rendering — `/robots.txt` must never fall through to an HTML response.
 */

import type { DbClient } from '../db/client'
import { isTemplatePage } from '@core/templates'
import {
  generateRobotsTxt,
  parseSeoMetadata,
  absoluteUrl,
  type SiteSeoSettings,
} from '@core/seo'
import { canonicalPublicOrigin, requestHostIsCanonical } from '../auth/security'
import { listPublishedRowsForSitemap } from '../repositories/data/publish'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { getPublishVersion } from './publishState'

// ---------------------------------------------------------------------------
// publishVersion-keyed cache
// ---------------------------------------------------------------------------

interface CachedSeoFile {
  version: number
  origin: string
  body: string
}

let robotsCache: CachedSeoFile | null = null
let sitemapCache: CachedSeoFile | null = null

/** Test seam — drop both cached bodies. */
export function resetSeoEndpointCachesForTests(): void {
  robotsCache = null
  sitemapCache = null
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Resolve the origin these files embed: configured canonical origin first,
 * request origin as the dynamic-endpoint fallback.
 */
function resolveOrigin(url: URL): string {
  return canonicalPublicOrigin() ?? url.origin
}

async function publishedSeoSettings(db: DbClient): Promise<SiteSeoSettings | undefined> {
  const snapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
  return snapshot?.site.settings.seo
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export async function serveRobotsTxt(db: DbClient, url: URL, req: Request): Promise<Response> {
  // Non-canonical host (preview/staging) → blanket Disallow, uncached: the
  // body doesn't depend on settings and must never be confused with the
  // production body (the cache keys on the resolved canonical origin, which
  // is identical for every host).
  if (requestHostIsCanonical(req) === false) {
    return new Response(generateRobotsTxt({ sitemapEnabled: false, blockAll: true }), {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
    })
  }

  const version = getPublishVersion()
  const origin = resolveOrigin(url)

  if (!robotsCache || robotsCache.version !== version || robotsCache.origin !== origin) {
    const seo = await publishedSeoSettings(db)
    const body = generateRobotsTxt({
      robots: seo?.robots,
      sitemapEnabled: seo?.sitemap?.enabled !== false,
      origin,
    })
    robotsCache = { version, origin, body }
  }

  return new Response(robotsCache.body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

// ---------------------------------------------------------------------------
// sitemap.xml
// ---------------------------------------------------------------------------

interface SitemapEntry {
  loc: string
  lastmod?: string
}

async function collectSitemapEntries(db: DbClient, origin: string): Promise<SitemapEntry[]> {
  const snapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
  if (!snapshot) return []

  const seo = snapshot.site.settings.seo
  const excluded = new Set(seo?.sitemap?.excludedTargets ?? [])
  const entries: SitemapEntry[] = []

  // Published routable pages — templates are never directly routable, and
  // noindex pages exclude themselves.
  for (const page of snapshot.site.pages) {
    if (isTemplatePage(page)) continue
    if (page.seo?.noindex === true) continue
    if (excluded.has(`page:${page.id}`)) continue
    const slug = page.slug.replace(/^\/+/, '')
    const routePath = slug === 'index' || slug === '' ? '/' : `/${slug}`
    entries.push({ loc: absoluteUrl(origin, routePath) })
  }

  // Published post-type rows with route bases.
  const rows = await listPublishedRowsForSitemap(db)
  for (const row of rows) {
    const rowSeo = parseSeoMetadata(row.cells.seo)
    if (rowSeo?.noindex === true) continue
    if (excluded.has(`row:${row.rowId}`)) continue
    entries.push({
      loc: absoluteUrl(origin, `${row.tableRouteBase}/${row.rowSlug}`),
      lastmod: row.publishedAt,
    })
  }

  return entries
}

export async function serveSitemapXml(db: DbClient, url: URL): Promise<Response> {
  const version = getPublishVersion()
  const origin = resolveOrigin(url)

  const seo = await publishedSeoSettings(db)
  if (seo?.sitemap?.enabled === false) {
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  if (!sitemapCache || sitemapCache.version !== version || sitemapCache.origin !== origin) {
    const entries = await collectSitemapEntries(db, origin)
    const urls = entries
      .map((entry) => {
        const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ''
        return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`
      })
      .join('\n')
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `${urls}${urls ? '\n' : ''}</urlset>\n`
    sitemapCache = { version, origin, body }
  }

  return new Response(sitemapCache.body, {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  })
}
