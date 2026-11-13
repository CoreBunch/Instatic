import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { jsonResponse, methodNotAllowed } from '../../http'
import { getUpdateDetails, getUpdateStatus } from '../../updates/client'
import { CMS_API_PREFIX } from './shared'

const PREFIX = `${CMS_API_PREFIX}/updates`

export async function handleUpdatesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const path = new URL(req.url).pathname
  if (path !== PREFIX && path !== `${PREFIX}/details` && path !== `${PREFIX}/check`) return null
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  const manual = path === `${PREFIX}/check`
  if (req.method !== (manual ? 'POST' : 'GET')) return methodNotAllowed()
  const status = path === PREFIX ? await getUpdateStatus() : await getUpdateDetails(manual)
  return jsonResponse(status, { headers: { 'Cache-Control': 'private, no-store' } })
}
