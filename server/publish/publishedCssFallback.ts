/** Recreates exactly the CSS linked by live, localized route releases. */
import { registry } from '@core/module-engine'
import type { Page, SiteDocument } from '@core/page-tree'
import type { SiteCssBundleId } from '@core/publisher'
import { buildRouteFrame } from '@core/templates/contextFrames'
import { composeTemplateChain, resolveNotFoundTemplate, resolveTemplateChain } from '@core/templates'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { DbClient } from '../db/client'
import { getPublishedRouteInventoryForVersion } from './publishedRoutes'
import { projectPublishedSite, readPublishedRouteContext } from './publishedRouteContext'
import { getPublishedSnapshotsForVersion } from './publishedSnapshotCache'
import { prefetchMediaAssets } from './mediaPrefetch'
import { prefetchLoopData, publishedDataRowToLoopItem } from './loopPrefetch'
import { buildPublishedSiteCssBundle } from './siteCssBundle'

export async function rebuildPublishedCss(
  db: DbClient, bundleId: SiteCssBundleId, requestedHash: string, version: number,
): Promise<string | null> {
  async function match(page: Page, site: SiteDocument, path: string, entryStack: TemplateRenderDataContext['entryStack'] = []) {
    const url = new URL(path, site.settings.publicOrigin ?? 'http://localhost')
    const templateContext = { entryStack, route: buildRouteFrame(url.toString()) }
    const loopData = await prefetchLoopData(page, site, db, url)
    const mediaAssets = await prefetchMediaAssets(page, site, registry, db, { templateContext, loopData })
    const file = buildPublishedSiteCssBundle(site, registry, page, version, { mediaAssets })[bundleId]
    return file.hash === requestedHash ? file.content : null
  }
  const inventory = await getPublishedRouteInventoryForVersion(db, version)
  for (const route of inventory.routes) {
    const context = await readPublishedRouteContext(db, route, inventory)
    if (!context) continue
    const body = await match(context.page, context.snapshot.site, route.path,
      context.row ? [publishedDataRowToLoopItem(context.row)] : [])
    if (body !== null) return body
  }
  for (const snapshot of await getPublishedSnapshotsForVersion(db, version)) {
    const site = projectPublishedSite(snapshot.site, inventory, snapshot.localeId ?? snapshot.site.localeId ?? '')
    const template = resolveNotFoundTemplate(site)
    if (!template) continue
    const page = composeTemplateChain(resolveTemplateChain(site, { kind: 'page' }), { kind: 'page', page: template })
    const body = await match(page, site, '/404')
    if (body !== null) return body
  }
  return null
}
