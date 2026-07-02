/**
 * Pages read endpoint backed by `data_rows` (table_id = 'pages').
 *
 *   GET /admin/api/cms/pages       — list all non-deleted page rows as
 *                                    DataRow[] (gated by `site.read`). The
 *                                    client adapter converts these to Page[]
 *                                    via pageFromRow.
 *   GET /admin/api/cms/pages?id=X  — the single row X (empty `rows` when it
 *                                    is deleted or not a page) — the conflict
 *                                    banner's "Load theirs" fetch.
 *
 * The response intentionally returns raw DataRow objects (not Page objects)
 * so the client adapter can reconstruct Pages via pageFromRow without a
 * round-trip through a second validation layer on the server. The adapter
 * validates pages via validatePages immediately after conversion.
 *
 * Writes go through the transactional site-document save
 * (PUT /admin/api/cms/site-document — see ./siteDocument.ts), which persists
 * shell + pages + components + layouts atomically.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { methodNotAllowed } from '../../http'
import { CMS_API_PREFIX, siteCollectionRowsResponse } from './shared'

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/pages`) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user

  return siteCollectionRowsResponse(db, url, 'pages')
}
