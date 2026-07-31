/**
 * Entry routes take their runtime manifest from the template that renders
 * them, not from whatever page the site-wide snapshot happens to name.
 *
 * `getLatestPublishedSiteSnapshot` is `order by data_rows.created_at asc limit
 * 1` — the first published page ever created. It exists to carry `site_json`,
 * and its `runtime_assets_json` used to ride along. Entry routes are rendered
 * from a template plus a data row rather than from a page, so they inherited
 * that manifest wholesale: every entry route on a site served one arbitrary
 * page's scripts, and `assetScopeAppliesToPage` was never consulted on the
 * path at all.
 *
 * Over-inclusion was what surfaced in practice — a script scoped to two pages
 * shipping on ten entry routes — but the same bug under-includes just as
 * easily: if the oldest page carries no scripts, a scoped script reaches
 * nothing.
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { snapshotForEntryRoute } from '../../../server/publish/entryTemplateSnapshot'
import { makeSite } from '../fixtures'

const postsTarget = { kind: 'postTypes' as const, tableSlugs: ['posts'] }

function runtimeAssets(name: string) {
  return {
    scripts: [{ publicPath: `/_instatic/assets/${name}/classic/001-${name}.js`, placement: 'body-end' as const }],
  }
}

/** A site whose first page is unrelated and whose second is the entry template. */
function siteSnapshot(): PublishedPageSnapshot {
  const site = makeSite()
  site.pages[0].id = 'oldest-page'
  site.pages.push({
    ...structuredClone(site.pages[0]),
    id: 'post-template',
    slug: 'post-template',
    template: { enabled: true, target: postsTarget, priority: 10 },
  })
  return { cmsSnapshotVersion: 1, pageRowId: 'oldest-page', site }
}

/** Stands in for the DB: only `getPublishedPageSnapshotById` is reached. */
function dbReturning(byPageId: Record<string, unknown>): DbClient {
  const fake = (async (_strings: TemplateStringsArray, ...params: unknown[]) => {
    const pageId = String(params[0])
    const assets = byPageId[pageId]
    return assets
      ? { rows: [{ row_id: pageId, site_json: makeSite(), runtime_assets_json: assets }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }) as unknown as DbClient
  return fake
}

describe('entry-route runtime manifest', () => {
  it('uses the entry template\'s own manifest, not the site snapshot\'s', async () => {
    const snapshot = siteSnapshot()
    const db = dbReturning({ 'post-template': runtimeAssets('template') })

    const resolved = await snapshotForEntryRoute(db, snapshot, 'posts')

    expect(resolved.runtimeAssets?.scripts[0]?.publicPath).toContain('001-template.js')
  })

  it('serves no scripts when the template has none, rather than another page\'s', async () => {
    // Reproduce the old shape: a site snapshot already carrying the oldest
    // page's manifest, and a template with none of its own. The old code
    // passed that straight through, so every entry route on the site served
    // `001-oldest.js`.
    const snapshot = { ...siteSnapshot(), runtimeAssets: runtimeAssets('oldest') }
    const db = dbReturning({})

    const resolved = await snapshotForEntryRoute(db, snapshot, 'posts')

    expect(resolved.runtimeAssets?.scripts[0]?.publicPath ?? '').not.toContain('001-oldest.js')
  })

  it('overrides a stale manifest on the site snapshot with the template\'s', async () => {
    const snapshot = { ...siteSnapshot(), runtimeAssets: runtimeAssets('oldest') }
    const db = dbReturning({ 'post-template': runtimeAssets('template') })

    const resolved = await snapshotForEntryRoute(db, snapshot, 'posts')

    expect(resolved.runtimeAssets?.scripts[0]?.publicPath).toContain('001-template.js')
  })

  it('leaves the site document untouched so the resolved chain still applies', async () => {
    const snapshot = siteSnapshot()
    const db = dbReturning({ 'post-template': runtimeAssets('template') })

    const resolved = await snapshotForEntryRoute(db, snapshot, 'posts')

    expect(resolved.site).toBe(snapshot.site)
  })

  it('falls back to the site snapshot when the table has no entry template', async () => {
    const snapshot = siteSnapshot()
    const db = dbReturning({ 'post-template': runtimeAssets('template') })

    const resolved = await snapshotForEntryRoute(db, snapshot, 'no-such-table')

    expect(resolved).toBe(snapshot)
  })
})
