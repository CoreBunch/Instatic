/** Rebuilds every live dependency surface after a publication or retraction. */
import { buildLocalizedPath } from '@core/localization-routing'
import type { DbClient } from '../db/client'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { listPublishedRuntimeAssetsForVersion } from '../repositories/runtimeAsset'
import type { PublishedPageSnapshot } from '../repositories/publish'
import type { RendererOutput } from './publicRenderer'
import { renderPublishedNotFound, renderResolvedPublishedRoute } from './publicRenderer'
import { loadPublishedRouteInventory } from './publishedRoutes'
import { projectPublishedSite, readPublishedRouteContext } from './publishedRouteContext'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import { buildLocalizedSitemap } from './localizedSeo'
import { getPublishVersion, markPublishedArtefactsCurrent, withPublishLock } from './publishState'
import { notFoundArtefactPath, prepareInactiveSlot, swapSlot, writeArtefact, writeStaticAsset } from './staticArtefact'
import { snapshotForNotFoundRoute } from './entryTemplateSnapshot'

/** After a committed visibility change, refresh every affected public surface. */
export async function refreshPublishedRoutes(db: DbClient, uploadsDir: string): Promise<void> {
  await withPublishLock(() => rebakePublishedRoutes(db, uploadsDir, getPublishVersion()))
}

export async function rebakePublishedRoutes(db: DbClient, uploadsDir: string, version: number): Promise<void> {
  const inventory = await loadPublishedRouteInventory(db)
  const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
  const assets = new Set<string>()
  const encoder = new TextEncoder()
  async function writeAssets(rendered: RendererOutput, snapshot: PublishedPageSnapshot): Promise<void> {
    for (const file of Object.values(rendered.cssBundle)) {
      const path = `/_instatic/css/${file.filename}`
      if (assets.has(path) || file.content.length === 0) continue
      await writeStaticAsset(slotDir, path, encoder.encode(file.content))
      assets.add(path)
    }
    if (snapshot.versionId) for (const asset of await listPublishedRuntimeAssetsForVersion(db, snapshot.versionId)) {
      if (assets.has(asset.publicPath)) continue
      await writeStaticAsset(slotDir, asset.publicPath, asset.bytes)
      assets.add(asset.publicPath)
    }
  }
  let publicOrigin: string | undefined
  for (const locale of inventory.locales.filter((entry) => entry.enabled)) {
    const published = await getLatestPublishedSiteSnapshot(db, locale.id)
    if (!published) continue
    const site = projectPublishedSite(published.site, inventory, locale.id)
    publicOrigin ??= site.settings.publicOrigin
    const snapshot = await snapshotForNotFoundRoute(db, { ...published, site })
    const path = buildLocalizedPath(locale, '404')
    const rendered = await renderPublishedNotFound(snapshot, { db, url: new URL(path, publicOrigin ?? 'http://localhost'), publishVersion: version })
    if (rendered) {
      const html = await applyPublishedHtmlPipeline(rendered, db)
      await writeArtefact(slotDir, notFoundArtefactPath(locale.id), html)
      // Conventional static-export fallback remains available unless an actual
      // published content route already owns this URL.
      if (!inventory.byPath.has(path)) await writeArtefact(slotDir, path, html)
      await writeAssets(rendered, snapshot)
    }
  }
  for (const route of inventory.routes) {
    const context = await readPublishedRouteContext(db, route, inventory)
    if (!context) continue
    publicOrigin ??= context.snapshot.site.settings.publicOrigin
    const url = new URL(route.path, publicOrigin ?? 'http://localhost')
    const rendered = await renderResolvedPublishedRoute(context, db, url, inventory, version)
    if (!rendered) continue
    await writeArtefact(slotDir, route.path, await applyPublishedHtmlPipeline(rendered, db))
    await writeAssets(rendered, context.snapshot)
  }
  if (publicOrigin) await writeStaticAsset(slotDir, '/sitemap.xml', encoder.encode(buildLocalizedSitemap(inventory, publicOrigin)))
  await swapSlot(uploadsDir, slot)
  markPublishedArtefactsCurrent(version)
}
