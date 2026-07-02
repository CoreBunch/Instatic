/**
 * Visual Components read endpoint backed by `data_rows` (table_id = 'components').
 *
 *   GET /admin/api/cms/components      — list all non-deleted component rows
 *                                        as DataRow[] (gated by `site.read`).
 *                                        The client adapter converts these to
 *                                        VisualComponent[] via
 *                                        visualComponentFromRow + validateVisualComponents.
 *   GET /admin/api/cms/components?id=X — the single row X (empty `rows` when
 *                                        deleted or not a component) — the
 *                                        conflict banner's "Load theirs" fetch.
 *
 * The response returns raw DataRow objects (not VisualComponent objects) so
 * the client adapter can reconstruct VCs via visualComponentFromRow without a
 * second validation layer on the server.
 *
 * Writes go through the transactional site-document save
 * (PUT /admin/api/cms/site-document — see ./siteDocument.ts), which persists
 * shell + pages + components + layouts atomically.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { methodNotAllowed } from '../../http'
import { CMS_API_PREFIX, siteCollectionRowsResponse } from './shared'

export async function handleComponentsRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/components`) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user

  return siteCollectionRowsResponse(db, url, 'components')
}
