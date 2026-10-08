import type { DbClient } from '../db/client'
import type { PublishedPageSnapshot } from '../repositories/publish'
import type { PublishedDataRow } from '@core/data/schemas'
import { isTemplatePage, resolveNotFoundTemplate } from '@core/templates'
import { getDataRowRedirectByRoute, getPublishedDataRowByRoute } from '../repositories/data/publish'
import { getPublishedPageBySlug } from '../repositories/publish'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { snapshotForEntryRoute, snapshotForNotFoundRoute } from './entryTemplateSnapshot'
import { getPublishVersion } from './publishState'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Normalise an inbound URL pathname to the slug used by the published-page
 * lookup. The empty path (`/`) maps to the canonical `index` slug.
 *
 * Shared with the loop runtime so per-page slug resolution stays consistent.
 */
export function publicSlugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

/**
 * Split a `/<table-route>/<row-slug>` pathname into its components, ready
 * for `getPublishedDataRowByRoute`. Returns `null` for paths that don't
 * have at least two segments — the caller should treat those as
 * "not a content-row URL" and move on.
 */
export function contentRouteFromPath(pathname: string): { tableRouteBase: string; rowSlug: string } | null {
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
export type PublicRouteResolution =
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
 * The row path also needs the site snapshot to find explicitly authored entry
 * templates; when there isn't one, we return `not-found` rather than inventing
 * a fallback document.
 */
export async function resolvePublicRoute(
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
    // Row routes render through explicitly authored entry templates. A missing
    // site snapshot means there is no published template surface to consult, so
    // surface that as not-found rather than inventing a fallback document. The
    // snapshot is memoised per publish version, so warm row requests skip the
    // full-site parse.
    const siteSnapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
    if (!siteSnapshot) return { kind: 'not-found' }
    // That snapshot carries no runtime manifest — an entry route takes the one
    // belonging to the template that actually renders it.
    const snapshot = await snapshotForEntryRoute(db, siteSnapshot, row.tableSlug)
    return { kind: 'row', snapshot, row }
  }

  const redirect = await getDataRowRedirectByRoute(db, route.tableRouteBase, route.rowSlug)
  if (redirect) {
    return { kind: 'redirect', location: `${redirect.targetPath}${url.search}` }
  }

  return { kind: 'not-found' }
}

/** The native 404 template supplies the published not-found surface. */
export async function resolvePublishedNotFoundRoute(db: DbClient): Promise<PublishedPageSnapshot | null> {
  const snapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
  if (!snapshot || !resolveNotFoundTemplate(snapshot.site)) return null
  return snapshotForNotFoundRoute(db, snapshot)
}
