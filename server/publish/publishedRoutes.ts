import { createPublishedRouteInventory, type PublishedRouteInventory } from '@core/localization-routing'
import type { DbClient } from '../db/client'
import { listLocales } from '../repositories/localization'
import { listPublishedRouteCandidates } from '../repositories/localizationRoutes'
import { createVersionedSingleFlight, registerVersionedCacheReset } from './publishState'

let inventories = new WeakMap<DbClient, ReturnType<typeof createVersionedSingleFlight<PublishedRouteInventory>>>()
registerVersionedCacheReset(() => { inventories = new WeakMap() })

export async function getPublishedRouteInventoryForVersion(db: DbClient, version: number): Promise<PublishedRouteInventory> {
  let memo = inventories.get(db)
  if (!memo) {
    memo = createVersionedSingleFlight<PublishedRouteInventory>()
    inventories.set(db, memo)
  }
  const inventory = await memo.get(version, () => loadPublishedRouteInventory(db))
  if (!inventory) throw new Error('Published inventory could not be loaded')
  return inventory
}

/** Callers own publish locking and version caching; also accepts their transaction. */
export async function loadPublishedRouteInventory(db: DbClient): Promise<PublishedRouteInventory> {
  const [locales, candidates] = await Promise.all([
    listLocales(db),
    listPublishedRouteCandidates(db),
  ])
  return createPublishedRouteInventory(locales, candidates)
}
