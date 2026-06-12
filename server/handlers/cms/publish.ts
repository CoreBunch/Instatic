/**
 * Site publish endpoints.
 *
 *   POST /admin/api/cms/publish         — push the current draft as a new
 *                                          published snapshot (gated by
 *                                          `pages.publish` + step-up).
 *                                          Records an audit event with the
 *                                          page count.
 *   GET  /admin/api/cms/publish/status  — return the freshness of the
 *                                          current draft vs. the latest
 *                                          published snapshot (gated by
 *                                          `site.read`).
 *
 * Publish is step-up gated because it's the single highest-blast-radius
 * site action — one click replaces every public page on the live host.
 * A stolen session cookie alone shouldn't be enough to redeploy; the
 * caller must have re-entered their password within the last 15 min.
 * Step-up matches the pattern used by `users.manage` delete / suspend
 * and the `plugins.install` / `plugins.lifecycle` mutation surface.
 */
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { createAuditEvent } from '../../repositories/audit'
import { getDraftPublishStatus } from '../../repositories/publish'
import { publishDraftSite } from '../../publish/publishSite'
import { jsonResponse, methodNotAllowed } from '../../http'
import type { CmsHandlerOptions } from './shared'
import { requestAuditContext } from './shared'

export async function handlePublishRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/publish') {
    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp

    const result = await publishDraftSite(db, user.id, options.uploadsDir)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'publish',
      targetType: 'site',
      targetId: 'default',
      metadata: { publishedPages: result.publishedPages },
      ...requestAuditContext(req),
    })
    return jsonResponse(result)
  }

  if (url.pathname === '/admin/api/cms/publish/status') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user
    if (req.method !== 'GET') return methodNotAllowed()

    return jsonResponse(await getDraftPublishStatus(db))
  }

  return null
}
