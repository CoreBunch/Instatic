/**
 * Public-site routing entrypoint.
 *
 * Every visitor request for an HTML page — whether the URL maps to a
 * stand-alone published page (`/about`) or to a content row rendered
 * through its postType's entry template (`/posts/hello-world`) — flows
 * through this module. There used to be two parallel router branches:
 *
 *   - `tryServePublishedPage`   → page lookup by slug → render
 *   - `tryServeContentRoute`    → row lookup by route → template render
 *
 * Both branches produced the same `RendererOutput` shape and both fed
 * the same `applyPublishedHtmlPipeline`. The split predates the
 * pages→data_rows migration: pages used to be their own table. After
 * the migration, pages, posts, and components are all `data_rows` —
 * the difference between them is just the lookup strategy, not the
 * publishing model.
 *
 * This module consolidates the public-route surface:
 *
 *   1. `resolvePublicRoute(db, url)` walks the lookup order (page slug
 *      → data-row route → row redirect) and returns a
 *      `PublicRouteResolution`.
 *   2. `renderPublicResolution(db, url, uploadsDir?)` handles the full
 *      request. Layer A: when `uploadsDir` is set and the URL has no
 *      query string, it first tries `readArtefact` from the active
 *      publish slot. On a hit the pre-rendered HTML is returned
 *      immediately (no DB, no render). On a miss, it falls through to
 *      `resolvePublicRoute` + Layer B.
 *
 *      Layer B: a warm cache entry (only ever a 200 render at the current
 *      publish version) is served BEFORE route resolution, so cache hits do
 *      zero DB work. On a miss, redirects and not-founds resolve before the
 *      factory so they are never stored. The render factory is invoked at
 *      most once per concurrent key burst (single-flight) and its result is
 *      stored in the LRU keyed by (urlPath, queryString, publishVersion).
 *      The cache is invalidated by `bumpPublishVersion`, which fires on
 *      every mutation that changes what a published URL serves (publish,
 *      unpublish, soft-delete, table move).
 *
 * The `publicSlugFromPath` helper is exported because the loop runtime
 * (`server/handlers/cms/loop.ts`) needs the same path → slug
 * normalisation as the resolver does. Keeping the helper in one place
 * stops "the loop endpoint thinks `/about/` is a different slug than
 * `/about`" drift.
 *
 * Layer A disk-artefact contract:
 *   - Static artefacts are written at publish time by `publishDraftSite`
 *     (full publish) and `publishDataRow` (incremental publish).
 *   - `applyPublishedHtmlPipeline` fires at publish time for static
 *     routes — plugin frontend injections and filters are baked into
 *     the artefact. The disk path never calls the pipeline per request.
 *   - For non-static routes (loops, request-dependent bindings), the
 *     live-render fallback runs once per (urlPath, queryString, publishVersion)
 *     burst and the result is stored in the Layer B LRU.
 *   - Only no-query-string requests hit the disk path. A request with
 *     `?page=2` always falls through so Layer A never serves stale
 *     pagination output.
 */

import type { DbClient } from '../db/client'
import type { PublishedPageSnapshot } from '../repositories/publish'
import type { PublishedDataRow } from '@core/data/schemas'
import { isTemplatePage, resolveNotFoundTemplate } from '@core/templates'
import {
  getDataRowRedirectByRoute,
  getPublishedDataRowByRoute,
} from '../repositories/data/publish'
import { getPublishedPageBySlug } from '../repositories/publish'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import {
  renderPublishedDataRowTemplate,
  renderPublishedNotFound,
  renderPublishedSnapshot,
} from './publicRenderer'
import { NOT_FOUND_ARTEFACT_URL_PATH, readArtefact } from './staticArtefact'
import { getOrRender, peek } from './renderCache'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { getPublishVersion } from './publishState'
import { canonicalRenderQuery } from './loopPrefetch'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an inbound URL pathname to the slug used by the published-page
 * lookup. The empty path (`/`) maps to the canonical `index` slug.
 *
 * Shared with the loop runtime so per-page slug resolution stays consistent.
 */
function publicSlugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

/**
 * Split a `/<table-route>/<row-slug>` pathname into its components, ready
 * for `getPublishedDataRowByRoute`. Returns `null` for paths that don't
 * have at least two segments — the caller should treat those as
 * "not a content-row URL" and move on.
 */
function contentRouteFromPath(pathname: string): { tableRouteBase: string; rowSlug: string } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return {
    tableRouteBase: `/${parts.slice(0, -1).map((part) => decodeURIComponent(part)).join('/')}`,
    rowSlug: decodeURIComponent(parts[parts.length - 1]),
  }
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * Discriminated result of `resolvePublicRoute`. `not-found` means the
 * URL doesn't map to any published content; callers continue dispatch
 * to the next handler (e.g. the setup-wizard redirect). `redirect` is
 * an old row-slug → new path mapping; the caller emits a 301.
 */
type PublicRouteResolution =
  | { kind: 'page'; snapshot: PublishedPageSnapshot }
  | { kind: 'row'; snapshot: PublishedPageSnapshot; row: PublishedDataRow }
  | { kind: 'redirect'; location: string }
  | { kind: 'not-found' }

/**
 * Walk the lookup order for a public URL:
 *
 *   1. Page snapshot at the full slug (`/about` → page row with slug
 *      `about`).
 *   2. Data row at `<route-base>/<row-slug>` (`/posts/hello` → row
 *      `hello` under postType `posts`).
 *   3. Redirect from a previous slug (the row was renamed; old URL →
 *      new path).
 *
 * Page lookup wins over row lookup when both shapes are possible — a
 * page with slug `posts/hello` shadows a row at the same URL. That
 * matches the pre-unification routing order (`tryServePublishedPage`
 * ran before `tryServeContentRoute` in the dispatcher).
 *
 * The row path also needs the site snapshot to find the entry
 * template; when there isn't one (corrupt install / nothing published),
 * we return `not-found` rather than inventing a fallback document.
 */
async function resolvePublicRoute(
  db: DbClient,
  url: URL,
): Promise<PublicRouteResolution> {
  // Page at the full slug.
  const pageSlug = publicSlugFromPath(url.pathname)
  const pageSnapshot = await getPublishedPageBySlug(db, pageSlug)
  if (pageSnapshot) {
    const page = pageSnapshot.site.pages.find((p) => p.id === pageSnapshot.pageRowId)
    if (page && !isTemplatePage(page)) {
      return { kind: 'page', snapshot: pageSnapshot }
    }
    // Template page (a layout/entry template): never directly routable — it
    // only ever wraps other content. Fall through to row/redirect/not-found.
  }

  // Data-row routes need at least `/table/slug` shape.
  const route = contentRouteFromPath(url.pathname)
  if (!route) return { kind: 'not-found' }

  const row = await getPublishedDataRowByRoute(db, route.tableRouteBase, route.rowSlug)
  if (row) {
    // Every postType table has a default entry template auto-seeded
    // into the `pages` table on creation (and the boot backfill catches
    // any pre-existing table that's missing one). So a missing
    // siteSnapshot here means a corrupt install — surface that as
    // not-found rather than half-rendering. The snapshot is memoised per
    // publish version, so warm row requests skip the full-site parse.
    const siteSnapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
    if (!siteSnapshot) return { kind: 'not-found' }
    return { kind: 'row', snapshot: siteSnapshot, row }
  }

  const redirect = await getDataRowRedirectByRoute(db, route.tableRouteBase, route.rowSlug)
  if (redirect) {
    return { kind: 'redirect', location: `${redirect.targetPath}${url.search}` }
  }

  return { kind: 'not-found' }
}

// ---------------------------------------------------------------------------
// Resolution → Response
// ---------------------------------------------------------------------------

/**
 * Materialise a public URL into the `Response` the visitor sees.
 *
 * Returns `null` for `not-found` so the router can fall through to its
 * next handler (e.g. the setup-wizard redirect).
 *
 * Layer A fast-path: when `uploadsDir` is provided AND the request URL
 * has no query string, `readArtefact` is called first. On a hit the
 * pre-rendered HTML is returned immediately — no DB lookup, no render.
 * On a miss the resolution path below runs normally.
 *
 * Redirect and not-found resolutions are returned immediately without
 * consulting the cache — they are cheap to recompute and must not
 * poison the LRU.
 *
 * Layer B: the render + pipeline result for a 200 response is stored in
 * an in-memory LRU keyed by (urlPath, queryString). Entries become stale
 * when `bumpPublishVersion()` is called after any publish. Concurrent
 * requests for the same key share one in-flight factory (single-flight).
 *
 * A `row` resolution can still yield `null` here when the postType's
 * entry template selection misses (no matching template at all). That's
 * the same "render → 404" behaviour the pre-unification router had.
 */
export async function renderPublicResolution(
  db: DbClient,
  url: URL,
  uploadsDir?: string,
): Promise<Response | null> {
  // Canonicalise the query to the loop-pagination params the renderer actually
  // consumes. Junk params collapse to '' (so they never mint cache slots), and
  // real pagination keeps a bounded, canonical key (ISS-032).
  const canonicalQuery = canonicalRenderQuery(url.searchParams)

  // ── Layer A: disk artefact fast-path ─────────────────────────────────────
  // Only for requests whose canonical query is empty. Real loop pagination
  // (e.g. `?loop_x_page=2`) falls through to Layer B so it is never served the
  // canonical URL's baked HTML; junk query strings still hit the disk artefact.
  if (uploadsDir && canonicalQuery === '') {
    const html = await readArtefact(uploadsDir, url.pathname)
    if (html !== null) {
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
  }

  // ── Layer B fast-path: serve a warm cached render before resolving ───────
  // Only 200 renders are ever stored, so a version-matched hit can be served
  // without touching the DB. Route retractions (unpublish, soft-delete, table
  // move) bump the publish version, which turns every cached entry into a
  // miss — a deleted route can never be served from a stale entry.
  const cacheKey = { urlPath: url.pathname, queryString: canonicalQuery }
  const warm = peek(cacheKey)
  if (warm) {
    return new Response(warm.body, { headers: warm.headers, status: warm.status })
  }

  // Resolve outside the cache factory so redirects and not-founds are never
  // stored in the LRU.
  const resolution = await resolvePublicRoute(db, url)
  if (resolution.kind === 'not-found') return null
  if (resolution.kind === 'redirect') {
    return new Response(null, {
      status: 301,
      headers: { location: resolution.location },
    })
  }

  // ── Layer B: in-memory LRU cache for the expensive render path ───────────
  const cached = await getOrRender(
    cacheKey,
    async () => {
      const rendered = resolution.kind === 'page'
        ? await renderPublishedSnapshot(resolution.snapshot, { db, url })
        : await renderPublishedDataRowTemplate(resolution.snapshot, resolution.row, { db, url })
      if (!rendered) return null
      const html = await applyPublishedHtmlPipeline(rendered, db)
      return { body: html, headers: { 'content-type': 'text/html; charset=utf-8' }, status: 200 }
    },
  )
  if (!cached) return null
  return new Response(cached.body, { headers: cached.headers, status: cached.status })
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

/**
 * Materialise the site's 404 page for a GET that fell through every route.
 *
 * Serving order mirrors `renderPublicResolution`:
 *
 *   - Layer A: the `404.html` artefact baked by the full publish — one disk
 *     read, no DB. This is the path bot probes and crawler noise hit.
 *   - Layer B fallback (no uploadsDir / bake failed): live render through the
 *     LRU under the reserved `/404` key, so a burst of misses renders once.
 *     The entry is stored as a 200 body (the cache only holds 200 renders);
 *     status 404 is stamped on the Response here. A direct GET of `/404`
 *     served through `renderPublicResolution` returns the same body with
 *     status 200 — identical to how static hosts treat `404.html`.
 *
 * Returns `null` when the published site has no notFound template (or nothing
 * is published at all) — the dispatcher then falls back to its bare JSON 404.
 *
 * The render is seeded with a synthetic `/404` URL (not the requested one) so
 * the cached body — like the baked artefact — is identical for every missed
 * path; request-dependent nodes are holes and hydrate per request anyway.
 */
export async function renderNotFoundResponse(
  db: DbClient,
  url: URL,
  uploadsDir?: string,
): Promise<Response | null> {
  const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' }

  // ── Layer A: baked 404 artefact ───────────────────────────────────────────
  if (uploadsDir) {
    const html = await readArtefact(uploadsDir, NOT_FOUND_ARTEFACT_URL_PATH)
    if (html !== null) {
      return new Response(html, { status: 404, headers: htmlHeaders })
    }
  }

  // ── Layer B: live render through the LRU under the reserved /404 key ─────
  const cacheKey = { urlPath: NOT_FOUND_ARTEFACT_URL_PATH, queryString: '' }
  const warm = peek(cacheKey)
  if (warm) {
    return new Response(warm.body, { headers: warm.headers, status: 404 })
  }

  const snapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
  if (!snapshot || !resolveNotFoundTemplate(snapshot.site)) return null

  const syntheticUrl = new URL(NOT_FOUND_ARTEFACT_URL_PATH, url.origin)
  const cached = await getOrRender(cacheKey, async () => {
    const rendered = await renderPublishedNotFound(snapshot, { db, url: syntheticUrl })
    if (!rendered) return null
    const html = await applyPublishedHtmlPipeline(rendered, db)
    return { body: html, headers: htmlHeaders, status: 200 }
  })
  if (!cached) return null
  return new Response(cached.body, { headers: cached.headers, status: 404 })
}
