/** Active frozen snapshots used by content-addressed CSS and module assets. */
import type { DbClient } from '../db/client'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { getPublishedRouteInventoryForVersion } from './publishedRoutes'
import { createVersionedSingleFlight, registerVersionedCacheReset } from './publishState'

let caches = new WeakMap<DbClient, ReturnType<typeof createVersionedSingleFlight<PublishedPageSnapshot[]>>>()
registerVersionedCacheReset(() => { caches = new WeakMap() })

export async function getPublishedSnapshotsForVersion(db: DbClient, version: number): Promise<PublishedPageSnapshot[]> {
  let cache = caches.get(db)
  if (!cache) { cache = createVersionedSingleFlight<PublishedPageSnapshot[]>(); caches.set(db, cache) }
  return await cache.get(version, async () => {
    const inventory = await getPublishedRouteInventoryForVersion(db, version)
    const snapshots: PublishedPageSnapshot[] = []
    const seen = new Set<string>()
    for (const entry of [...inventory.routes, ...inventory.dependencies]) {
      const key = JSON.stringify([entry.localeId, entry.siteSnapshotId])
      if (seen.has(key)) continue
      seen.add(key)
      const snapshot = await getLatestPublishedSiteSnapshot(db, entry.localeId, entry.siteSnapshotId)
      if (snapshot) snapshots.push(snapshot)
    }
    return snapshots
  }) ?? []
}
