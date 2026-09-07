/** Replays publish hooks for the immutable releases of every live page language. */
import type { DbClient } from '../db/client'
import { getPublishVersion } from './publishState'
import { getPublishedRouteInventoryForVersion } from './publishedRoutes'
import { readPublishedRouteContext } from './publishedRouteContext'
import { renderResolvedPublishedRoute } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'

/** Only live variants participate; replaying hooks never publishes a draft. */
export async function republishAllPages(db: DbClient): Promise<number> {
  const version = getPublishVersion()
  const inventory = await getPublishedRouteInventoryForVersion(db, version)
  let count = 0
  for (const route of inventory.routes.filter((entry) => entry.kind === 'page')) {
    try {
      const context = await readPublishedRouteContext(db, route, inventory)
      if (!context) continue
      const url = new URL(route.path, context.snapshot.site.settings.publicOrigin ?? 'http://localhost')
      const rendered = await renderResolvedPublishedRoute(context, db, url, inventory, version)
      if (!rendered) continue
      await applyPublishedHtmlPipeline(rendered, db)
      count++
    } catch (err) {
      console.error(`[publish:republish] ${route.contentId}/${route.localeId} failed:`, err)
    }
  }
  return count
}
