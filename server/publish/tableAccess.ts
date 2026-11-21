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

/** Returns false when there is no such table. */
export function setTableAccess(
  db: DbClient,
  tableId: string,
  rule: AccessRule,
  uploadsDir?: string,
): Promise<boolean> {
  return withPublishLock(async () => {
    if (!(await writeTableAccess(db, tableId, rule))) return false
    if (uploadsDir) await removeAllHtmlArtefactsInPlace(uploadsDir)
    bumpPublishVersion()
    return true
  })
}
