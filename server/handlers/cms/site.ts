/**
 * Draft-site shell read endpoint.
 *
 *   GET /admin/api/cms/site — load the draft site shell (gated by `site.read`).
 *                              Returns the SiteShell without pages; the client
 *                              adapter fetches pages separately via GET /pages.
 *
 * Writes go through the transactional site-document save
 * (PUT /admin/api/cms/site-document — see ./siteDocument.ts), which persists
 * shell + pages + components + layouts atomically.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { getDraftSite } from '../../repositories/site'
import { jsonResponse, methodNotAllowed } from '../../http'

export async function handleSiteRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/admin/api/cms/site') return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user

  const shell = await getDraftSite(db)
  if (!shell) return jsonResponse({ error: 'draft site not found' }, { status: 404 })
  return jsonResponse({ site: shell })
}
