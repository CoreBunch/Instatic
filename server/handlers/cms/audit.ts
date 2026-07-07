/**
 * Audit log read endpoint (gated by `audit.read`).
 *
 *   GET /admin/api/cms/audit — list the latest audit events in reverse-
 *                              chronological order. Query filters are not
 *                              implemented; callers get the repository default.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { listAuditEvents } from '../../repositories/audit'
import { jsonResponse, methodNotAllowed } from '../../http'
import { CMS_API_PREFIX } from './shared'

export async function handleAuditRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/audit`) return null

  const actor = await requireCapability(req, db, 'audit.read')
  if (actor instanceof Response) return actor
  if (req.method !== 'GET') return methodNotAllowed()
  return jsonResponse({ events: await listAuditEvents(db) })
}
