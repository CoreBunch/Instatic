/**
 * Sitemap + robots.txt for the published site.
 *
 * Two reserved public routes, owned before the public-slug resolver:
 *
 *   - `GET /sitemap.xml` — a `urlset` of every published, directly-routable
 *     URL (standalone pages + content-row routes), each with a `<lastmod>`.
 *   - `GET /robots.txt`  — allow-all except `/admin`, plus a `Sitemap:` line.
 *
 * Both are derived from the published database on each request (sitemaps are
 * crawled infrequently and the response is cheap to rebuild). Absolute URLs
 * are anchored to `canonicalPublicOrigin` — the configured public origin
 * matching the request host (falling back to the request's own origin when
 * none is configured), so a TLS-terminating edge that hands the container
 * plain HTTP can never leak `http://` locs into crawler-facing output.
 *
 * The route set mirrors what the public router (`publicRouter.ts`) will
 * actually serve a 200 for:
 *   - Published `pages` rows, EXCLUDING template pages (entry templates /
 *     layouts / the notFound page are never directly routable), keyed by
 *     `data_rows.slug` — the exact slug the resolver matches.
 *   - Published data-row routes (`/<table-route>/<row-slug>`), via
 *     `listPublishedRowRoutes` — the same list the full publish bakes.
 *
 * Template-page exclusion reuses the published `SiteDocument`: a page id present
 * in the snapshot and flagged `isTemplatePage` is dropped. A published page that
 * isn't in the latest snapshot (an unusual incremental-publish edge) is kept —
 * it resolves by slug, so omitting it would hide a live URL.
 */

import type { DbClient } from '../db/client'
import { canonicalPublicOrigin } from '../auth/security'
import { isTemplatePage } from '@core/templates'
import {
  getLatestPublishedSiteSnapshot,
  listPublishedPageRoutes,
} from '../repositories/publish'
import { listPublishedRowRoutes, publicDataPath } from '../repositories/data/publish'

const SITEMAP_PATH = '/sitemap.xml'
const ROBOTS_PATH = '/robots.txt'

/** One entry in the sitemap: an absolute-path route plus its last-modified time. */
export interface SitemapEntry {
  /** Root-relative URL path, e.g. `/`, `/about`, `/posts/hello`. */
  path: string
  /** ISO 8601 last-modified timestamp (W3C datetime) for `<lastmod>`. */
  lastmod: string
}

/**
 * Convert a published page's stored slug to its public URL path. Mirrors the
 * resolver's `publicSlugFromPath` in reverse: the canonical `index` slug is the
 * site root, everything else is `/<slug>`. Stray leading/trailing slashes on the
 * stored slug are normalised away so the emitted `<loc>` is canonical.
 */
export function pageSlugToPath(slug: string): string {
  const trimmed = slug.replace(/^\/+|\/+$/g, '')
  return trimmed === '' || trimmed === 'index' ? '/' : `/${trimmed}`
}

/**
 * Enumerate every published, directly-routable URL for the sitemap. Pages win
 * over content rows on a path collision (the resolver looks up pages first), so
 * a row route that resolves to the same path as a page is dropped.
 */
export async function collectSitemapEntries(db: DbClient): Promise<SitemapEntry[]> {
  const [snapshot, pageRoutes, rowRoutes] = await Promise.all([
    getLatestPublishedSiteSnapshot(db),
    listPublishedPageRoutes(db),
    listPublishedRowRoutes(db),
  ])

  const templatePageIds = new Set<string>(
    (snapshot?.site.pages ?? []).filter(isTemplatePage).map((page) => page.id),
  )

  const entries: SitemapEntry[] = []
  const seen = new Set<string>()

  for (const route of pageRoutes) {
    if (templatePageIds.has(route.pageId)) continue
    const path = pageSlugToPath(route.slug)
    if (seen.has(path)) continue
    seen.add(path)
    entries.push({ path, lastmod: route.updatedAt })
  }

  for (const route of rowRoutes) {
    const path = publicDataPath(route.tableRouteBase, route.rowSlug)
    if (seen.has(path)) continue
    seen.add(path)
    entries.push({ path, lastmod: route.updatedAt })
  }

  return entries
}

/** XML-escape a value for use inside `<loc>` / element text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Build the `sitemap.xml` document. Pure: `origin` is the scheme+host the loc
 * URLs are anchored to (no trailing slash), `entries` are root-relative paths.
 */
export function buildSitemapXml(origin: string, entries: readonly SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const loc = escapeXml(`${origin}${entry.path}`)
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>\n  </url>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/** Build `robots.txt`: allow all except `/admin`, and advertise the sitemap. */
export function buildRobotsTxt(origin: string): string {
  return `User-agent: *\nDisallow: /admin\n\nSitemap: ${origin}${SITEMAP_PATH}\n`
}

/**
 * Own the two reserved SEO routes. Returns `null` for anything else (or a
 * non-GET request) so the dispatcher keeps walking.
 */
export async function handleSitemapRequest(
  req: Request,
  url: URL,
  ctx: { db: DbClient },
): Promise<Response | null> {
  if (req.method !== 'GET') return null

  if (url.pathname === SITEMAP_PATH) {
    const entries = await collectSitemapEntries(ctx.db)
    return new Response(buildSitemapXml(canonicalPublicOrigin(url), entries), {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    })
  }

  if (url.pathname === ROBOTS_PATH) {
    return new Response(buildRobotsTxt(canonicalPublicOrigin(url)), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    })
  }

  return null
}
