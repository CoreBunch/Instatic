import type { DbClient } from '../../../db/client'
import type { BranchScope } from '../../../branches/scope'
import { canReadTable, requireDataAccess } from '../../../auth/dataAccess'
import { getDataTable, readDataLocalization } from '../../../repositories/data'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, methodNotAllowed } from '../../../http'
import { CMS_API_PREFIX } from '../shared'

const QuerySchema = Type.Object({
  tableIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100, uniqueItems: true }),
  language: Type.Optional(Type.String({ minLength: 1 })),
})

/** A table-scoped text projection; no SiteFile or unrelated configuration is returned. */
export async function handleDataLocalizationRoute(req: Request, db: DbClient, scope: BranchScope): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/data/localization`) return null
  if (req.method !== 'GET') return methodNotAllowed()
  const user = await requireDataAccess(req, db)
  if (user instanceof Response) return user
  const query = safeParseValue(QuerySchema, { tableIds: url.searchParams.getAll('table'), ...(url.searchParams.has('language') ? { language: url.searchParams.get('language') } : {}) })
  if (!query.ok) return badRequest('Choose readable data tables and an explicit language')
  const tables = []
  for (const tableId of query.value.tableIds) {
    const table = await getDataTable(db, scope, tableId)
    if (!table || !canReadTable(user, table)) return jsonResponse({ error: 'Table not found' }, { status: 404 })
    tables.push(table)
  }
  return jsonResponse(await readDataLocalization(db, scope, user, tables, query.value.language))
}
