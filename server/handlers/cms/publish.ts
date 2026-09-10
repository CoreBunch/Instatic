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
import { RuntimeScriptBuildError } from '../../publish/runtime/buildError'
import { jsonResponse, methodNotAllowed } from '../../http'
import type { CmsHandlerOptions } from './shared'
import { requestAuditContext } from './shared'
import { PublishVariantSelectionSchema } from '@core/localization-schema'
import { badRequest, readValidatedBody } from '../../http'
import { listLocales } from '../../repositories/localization'
import { listDataRows } from '../../repositories/data'
import { readTitleCell } from '@core/data/cells'
import { requestLocale } from './localeContext'
import { LocalizedRouteError } from '@core/localization-routing'
import { LocalizationError } from '../../repositories/localization'

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

    const selection = req.body ? await readValidatedBody(req, PublishVariantSelectionSchema) : {}
    if (!selection) return badRequest('Invalid publication selection')

    // publishDraftSite flushes the collab relay itself (see publishFlush.ts),
    // so the snapshot includes edits still inside the debounce window.
    let result: Awaited<ReturnType<typeof publishDraftSite>>
    try {
      result = await publishDraftSite(db, user.id, options.uploadsDir, selection)
    } catch (err) {
      if (err instanceof RuntimeScriptBuildError || err instanceof LocalizedRouteError || err instanceof LocalizationError) {
        return jsonResponse({ error: err.message }, { status: 422 })
      }
      throw err
    }
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'publish',
      targetType: 'site',
      targetId: 'default',
      metadata: { publishedPages: result.publishedPages, variantIds: selection.variants?.map((variant) => `${variant.rowId}:${variant.localeId}`) ?? null },
      ...requestAuditContext(req),
    })
    return jsonResponse(result)
  }

  if (url.pathname === '/admin/api/cms/publish/selection') {
    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user
    if (req.method !== 'GET') return methodNotAllowed()
    const locales = await listLocales(db)
    const rows = await Promise.all(locales.map((locale) => listDataRows(db, 'pages', { localeId: locale.id })))
    return jsonResponse({ locales, variants: rows.flat().map((row) => ({
      rowId: row.id, localeId: row.localeId, title: readTitleCell(row.cells), slug: row.slug,
      isTemplate: row.cells.templateEnabled === true,
      availability: row.localization?.availability ?? 'offline',
      scheduledPublishAt: row.scheduledPublishAt, publicPath: row.publicPath,
    })) })
  }

  if (url.pathname === '/admin/api/cms/publish/status') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user
    if (req.method !== 'GET') return methodNotAllowed()

    const locale = await requestLocale(req, db)
    if (locale instanceof Response) return locale
    return jsonResponse(await getDraftPublishStatus(db, { localeId: locale.id }))
  }

  return null
}
