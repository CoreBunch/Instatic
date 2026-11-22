/**
 * Change who may open a data table's rows.
 *
 * The rule is a live setting, so it has to take effect at once, not on the
 * next publish. Its rows can appear in two places: on the table's own entry
 * routes, and in lists on any other page. So every baked page is dropped
 * from the static slot, and the publish version is bumped, which empties the
 * render cache and reloads the access index. From the next request on,
 * pages render live (lists leaving the rows out for visitors who may not
 * open them) until the next publish bakes them again.
 */
import type { DbClient } from '../db/client'
import type { AccessRule } from '@core/members'
import { writeTableAccess } from '../repositories/data/tableAccess'
import { bumpPublishVersion, withPublishLock } from './publishState'
import { removeAllHtmlArtefactsInPlace } from './staticArtefact'

/**
 * Drop every baked page and bump the publish version, which empties the
 * render cache and reloads the access index. Run under the publish lock.
 */
async function forgetServedRoutes(uploadsDir: string | undefined): Promise<void> {
  if (uploadsDir) await removeAllHtmlArtefactsInPlace(uploadsDir)
  bumpPublishVersion()
}

/**
 * Something on `main` changed that can change who sees which route: a
 * table's route base, slug or deletion, a branch merge (or its undo) that
 * moves, deletes or restores entries, pages or tables. Nothing baked or
 * cached for the old shape may be served: the static slot is read without
 * asking who is asking. Pages render live until the next publish bakes them
 * again. The one function for this; an access change does the same steps.
 */
export function routeVisibilityChanged(uploadsDir?: string): Promise<void> {
  return withPublishLock(() => forgetServedRoutes(uploadsDir))
}

/** Returns false when there is no such table. */
export function setTableAccess(
  db: DbClient,
  tableId: string,
  rule: AccessRule,
  uploadsDir?: string,
): Promise<boolean> {
  return withPublishLock(async () => {
    if (!(await writeTableAccess(db, tableId, rule))) return false
    await forgetServedRoutes(uploadsDir)
    return true
  })
}
