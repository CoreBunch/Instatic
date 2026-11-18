/**
 * Meta endpoint — lean binding catalog for the instatic picker.
 *
 *   GET /admin/api/cms/data/_meta
 *
 * Returns `{ meta: DataMeta }` — a stripped-down view of all data tables and
 * their fields. The underscore prefix guarantees this can never collide with
 * an id-based route (table ids are nanoid strings without leading underscores).
 *
 * Access: any `content.*` capability (same guard as the table/row GET routes).
 */
import type { DbClient } from '../../../db/client'
import { buildDataMeta } from '@core/data/fields'
import { listDataTables } from '../../../repositories/data'
import { jsonResponse } from '../../../http'
import { CMS_API_PREFIX } from '../shared'
import { requireDataAccess } from './access'
import type { BranchScope } from '../../../branches/scope'

export async function handleDataMetaRoutes(
  req: Request,
  db: DbClient,
  scope: BranchScope,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  if (req.method === 'GET' && pathname === `${CMS_API_PREFIX}/data/_meta`) {
    const access = await requireDataAccess(req, db)
    if (access instanceof Response) return access

    const tables = await listDataTables(db, scope)
    return jsonResponse({ meta: buildDataMeta(tables) })
  }

  return null
}
