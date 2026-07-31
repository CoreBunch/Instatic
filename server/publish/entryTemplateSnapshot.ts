/**
 * Runtime assets for a route rendered through a template.
 *
 * Runtime assets are per-PAGE: `publishSite.ts` bundles them once per row in
 * `site.pages`, honouring each script's `scope` through
 * `assetScopeAppliesToPage`. Entry routes (`/rooms/<slug>`) are not pages —
 * they are rendered per request from a template page plus a data row — so they
 * have no manifest of their own and have to borrow their template's.
 *
 * They used to borrow whatever `getLatestPublishedSiteSnapshot` returned, which
 * is `order by data_rows.created_at asc limit 1`: the first published page ever
 * created. That getter exists to supply `site_json`; its `runtime_assets_json`
 * rode along by accident. So every entry route on a site served one arbitrary
 * page's scripts, and the scope predicate was never consulted on that path at
 * all — a script scoped to two pages shipped on all of them, and a script the
 * oldest page did not carry never shipped anywhere.
 *
 * `getLatestPublishedSiteSnapshot` no longer carries runtime assets, so the
 * failure mode if this resolution misses is "no scripts", never "someone
 * else's scripts".
 */
import type { DbClient } from '../db/client'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { getPublishedPageSnapshotById } from '../repositories/publish'
import { resolveNotFoundTemplate, resolveTemplateChain } from '@core/templates/templateMatching'

/**
 * `siteSnapshot` with the runtime manifest of the page that will actually
 * render `pageId`. The site document is kept from `siteSnapshot` so it stays
 * the one the caller resolved its template chain against, even if a publish
 * lands between the two reads.
 */
async function withRuntimeAssetsOfPage(
  db: DbClient,
  siteSnapshot: PublishedPageSnapshot,
  pageId: string,
): Promise<PublishedPageSnapshot> {
  const own = await getPublishedPageSnapshotById(db, pageId)
  // The rendering page's manifest is authoritative, INCLUDING when it has
  // none. Merging only the present case would let a manifest that arrived on
  // `siteSnapshot` from anywhere else survive onto a route it was never
  // scoped to — which is the whole defect.
  const { runtimeAssets: _discarded, ...withoutAssets } = siteSnapshot
  return own?.runtimeAssets
    ? { ...withoutAssets, runtimeAssets: own.runtimeAssets }
    : withoutAssets
}

/**
 * Snapshot to render an entry route of `tableSlug` with — the innermost
 * template in its chain supplies the runtime manifest.
 */
export async function snapshotForEntryRoute(
  db: DbClient,
  siteSnapshot: PublishedPageSnapshot,
  tableSlug: string,
): Promise<PublishedPageSnapshot> {
  const chain = resolveTemplateChain(siteSnapshot.site, { kind: 'entry', tableSlug })
  const innermost = chain[chain.length - 1]
  if (!innermost) return siteSnapshot
  return await withRuntimeAssetsOfPage(db, siteSnapshot, innermost.id)
}

/** Snapshot to render the 404 route with — same reasoning as entry routes. */
export async function snapshotForNotFoundRoute(
  db: DbClient,
  siteSnapshot: PublishedPageSnapshot,
): Promise<PublishedPageSnapshot> {
  const template = resolveNotFoundTemplate(siteSnapshot.site)
  if (!template) return siteSnapshot
  return await withRuntimeAssetsOfPage(db, siteSnapshot, template.id)
}
