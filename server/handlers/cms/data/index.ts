/**
 * Data endpoints — meta, tables, and rows.
 *
 * Three route groups, dispatched in order. Each group's handler returns either
 * a `Response` (it claimed the URL) or `null` (not my route — try the next).
 * Splitting by resource keeps each file focused on one subject and matches
 * how the rest of `server/handlers/cms/*` is organized.
 *
 * URL surface owned by this folder:
 *   /admin/api/cms/data/_meta                     (GET)  ← matched first
 *   /admin/api/cms/data/authors                   (GET)
 *   /admin/api/cms/data/tables                    (GET, POST)
 *   /admin/api/cms/data/tables/:id                (GET, PATCH, DELETE)
 *   /admin/api/cms/data/tables/:id/rows           (GET, POST)
 *   /admin/api/cms/data/tables/:id/loop-preview   (GET)
 *   /admin/api/cms/data/rows/:id                  (GET, PUT, DELETE)
 *   /admin/api/cms/data/rows/:id/publish          (POST)
 *   /admin/api/cms/data/rows/:id/status           (PATCH)
 *   /admin/api/cms/data/rows/:id/author           (PATCH)
 *   /admin/api/cms/data/rows/:id/table            (PATCH)
 *
 * `_meta` is matched first because the underscore prefix makes it impossible
 * to collide with an id-based route (table ids are nanoid strings, no leading
 * underscores), and it avoids any risk of the table/:id pattern eating it.
 */
import type { DbClient } from '../../../db/client'
import type { BranchScope } from '../../../branches/scope'
import type { CmsHandlerOptions } from '../shared'
import { handleDataMetaRoutes } from './meta'
import { handleDataSearchRoute } from './search'
import { handleDataTableRoutes } from './tables'
import { handleDataRowRoutes } from './rows'

export async function handleDataRoutes(
  req: Request,
  db: DbClient,
  scope: BranchScope,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  return (await handleDataMetaRoutes(req, db, scope))
    ?? (await handleDataSearchRoute(req, db, scope))
    ?? (await handleDataTableRoutes(req, db, scope))
    ?? (await handleDataRowRoutes(req, db, scope, options))
}
