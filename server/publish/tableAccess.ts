/**
 * Change who may open a data table's entry routes.
 *
 * The rule is a live setting, so it has to take effect at once, not on the
 * next publish: the table's baked pages are removed from the static slot and
 * the publish version is bumped, which empties the render cache and reloads
 * the access index. From the next request on, every entry route of the table
 * goes through the per-request check.
 */
import type { DbClient } from '../db/client'
import type { AccessRule } from '@core/members'
import { listPublishedRowRoutes } from '../repositories/data/publish'
import { writeTableAccess } from '../repositories/data/tableAccess'
import { bumpPublishVersion, withPublishLock } from './publishState'
import { removeArtefactInPlace } from './staticArtefact'

/** Returns false when there is no such table. */
export function setTableAccess(
  db: DbClient,
  tableId: string,
  rule: AccessRule,
  uploadsDir?: string,
): Promise<boolean> {
  return withPublishLock(async () => {
    const routeBase = await writeTableAccess(db, tableId, rule)
    if (routeBase === null) return false
    if (uploadsDir && rule.level !== 'public') {
      for (const route of await listPublishedRowRoutes(db)) {
        if (route.tableRouteBase !== routeBase) continue
        await removeArtefactInPlace(uploadsDir, `${routeBase}/${encodeURIComponent(route.rowSlug)}`)
      }
    }
    bumpPublishVersion()
    return true
  })
}
