import { LocaleInputSchema, LocaleUpdateInputSchema } from '@core/localization-schema'
import type { DbClient } from '../../db/client'
import { requireAuthenticatedUser, requireCapability, userHasCapability } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { createLocale, getLocale, listLocales, LocalizationError, updateLocale } from '../../repositories/localization'
import { bumpPublishVersion, withPublishLock } from '../../publish/publishState'
import { loadPublishedRouteInventory } from '../../publish/publishedRoutes'
import { rebakePublishedRoutes } from '../../publish/rebakePublishedRoutes'
import { assertLocalePathPrefixAvailable, LocalizedRouteError, normalizeLocalePathPrefix } from '@core/localization-routing'
import { createAuditEvent } from '../../repositories/audit'
import { requestAuditContext, type CmsHandlerOptions } from './shared'

/** Languages are available to all authenticated authoring workspaces. */
export async function handleLocaleRoutes(req: Request, db: DbClient, options: CmsHandlerOptions = {}): Promise<Response | null> {
  const url = new URL(req.url)
  const match = /^\/admin\/api\/cms\/locales(?:\/([^/]+))?$/.exec(url.pathname)
  if (!match) return null
  const id = match[1]
  if (req.method === 'GET' && !id) {
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    return jsonResponse({ locales: await listLocales(db) })
  }
  if ((!id && req.method !== 'POST') || (id && req.method !== 'PATCH')) return methodNotAllowed()
  const user = await requireCapability(req, db, 'site.structure.edit')
  if (user instanceof Response) return user
  try {
    if (!id) {
      const input = await readValidatedBody(req, LocaleInputSchema)
      if (!input) return badRequest('Invalid language settings')
      // New languages start offline, independently of any inherited content.
      const locale = await withPublishLock(() => db.transaction(async (tx) => {
        const inventory = await loadPublishedRouteInventory(tx)
        assertLocalePathPrefixAvailable({ id: '', pathPrefix: normalizeLocalePathPrefix(input.pathPrefix.trim().toLowerCase()) }, inventory.routes)
        const created = await createLocale(tx, { ...input, enabled: false })
        await createAuditEvent(tx, { actorUserId: user.id, action: 'locale.create', targetType: 'locale', targetId: created.id,
          metadata: { code: created.code, pathPrefix: created.pathPrefix }, ...requestAuditContext(req) })
        return created
      }))
      return jsonResponse({ locale }, { status: 201 })
    }
    const input = await readValidatedBody(req, LocaleUpdateInputSchema)
    if (!input) return badRequest('Invalid language settings')
    const previous = await getLocale(db, id)
    if (!previous) return jsonResponse({ error: 'Language not found' }, { status: 404 })
    if (input.enabled !== undefined && input.enabled !== previous.enabled && !userHasCapability(user, 'pages.publish')) {
      return jsonResponse({ error: 'Publishing permission is required to change language availability' }, { status: 403 })
    }
    const locale = await withPublishLock(async () => {
      const updated = await db.transaction(async (tx) => {
        const current = await getLocale(tx, id)
        if (!current) return jsonResponse({ error: 'Language not found' }, { status: 404 })
        if (input.enabled !== undefined && input.enabled !== current.enabled && !userHasCapability(user, 'pages.publish')) {
          return jsonResponse({ error: 'Publishing permission is required to change language availability' }, { status: 403 })
        }
        const inventory = await loadPublishedRouteInventory(tx)
        const pathPrefix = normalizeLocalePathPrefix((input.pathPrefix ?? current.pathPrefix).trim().toLowerCase())
        assertLocalePathPrefixAvailable({ id, pathPrefix }, inventory.routes)
        const result = await updateLocale(tx, id, input)
        // Validate the prospective live set while rollback can still undo the
        // toggle; inactive variants may retain addresses from an older prefix.
        await loadPublishedRouteInventory(tx)
        await createAuditEvent(tx, { actorUserId: user.id, action: 'locale.update', targetType: 'locale', targetId: id,
          metadata: { code: result?.code ?? previous.code, enabled: result?.enabled ?? previous.enabled, pathPrefix }, ...requestAuditContext(req) })
        return result
      })
      if (!(updated instanceof Response)) {
        const version = bumpPublishVersion()
        // Rebuild switchers, alternates, lists and the sitemap from immutable
        // releases while the language change still owns the publication lock.
        if (options.uploadsDir) await rebakePublishedRoutes(db, options.uploadsDir, version)
      }
      return updated
    })
    if (locale instanceof Response) return locale
    return jsonResponse({ locale })
  } catch (err) {
    if (err instanceof LocalizationError || err instanceof LocalizedRouteError) return badRequest(err.message)
    throw err
  }
}
