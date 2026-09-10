import { Type } from '@core/utils/typeboxHelpers'
import { getDataTable, updateDataTableInTx } from '../../../repositories/data'
import { getDefaultLocale, listLocales, listTableLocalizations, saveTableLocalization } from '../../../repositories/localization'
import { createAuditEvent } from '../../../repositories/audit'
import { serializeCollabAwareWrite } from '../../../repositories/rowWriteEvents'
import { requireAuthenticatedUser, requireStepUp } from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { requestLocale } from '../localeContext'
import { requestAuditContext } from '../shared'
import { canManageTable, canReadTable, forbidden, hasContentRowAccess } from './access'

const RouteInputSchema = Type.Object({ routeBase: Type.String({ maxLength: 250 }) }, { additionalProperties: false })

export async function handleTableLocalizationRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const match = /^\/admin\/api\/cms\/data\/tables\/([^/]+)\/localizations$/.exec(new URL(req.url).pathname)
  if (!match) return null
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed()
  const user = await requireAuthenticatedUser(req, db)
  if (user instanceof Response) return user
  const tableId = decodeURIComponent(match[1])
  const table = await getDataTable(db, tableId)
  if (!table || (!canReadTable(user, table) && !hasContentRowAccess(user))) {
    return jsonResponse({ error: 'Collection not found' }, { status: 404 })
  }
  if (table.kind !== 'postType') return badRequest('Only content collections have translated URL paths')
  if (req.method === 'GET') {
    return jsonResponse({ locales: await listLocales(db), localizations: await listTableLocalizations(db, tableId) })
  }
  if (!canManageTable(user, table)) return forbidden()
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp instanceof Response) return stepUp
  const locale = await requestLocale(req, db)
  if (locale instanceof Response) return locale
  const input = await readValidatedBody(req, RouteInputSchema)
  if (!input) return badRequest('Invalid collection URL path')
  const localization = await serializeCollabAwareWrite(() => db.transaction(async (tx) => {
    const result = await saveTableLocalization(tx, tableId, locale.id, input.routeBase)
    const source = await getDefaultLocale(tx)
    if (result && source.id === locale.id) {
      await updateDataTableInTx(tx, tableId, { routeBase: result.routeBase, updatedByUserId: user.id })
    }
    await createAuditEvent(tx, { actorUserId: user.id, action: 'data.table.update', targetType: 'data_table', targetId: tableId,
      metadata: { localeId: locale.id, routeBase: result?.routeBase ?? input.routeBase }, ...requestAuditContext(req) })
    return result
  }))
  return jsonResponse({ localization })
}
