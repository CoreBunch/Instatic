/**
 * Cross-table data row search endpoint.
 *
 *   GET  /admin/api/cms/data/search?query=<q>&limit=<n>
 *
 * Returns a lightweight list of matching data rows (slug, table info, status)
 * for the spotlight content provider. Full row cells are not returned — callers
 * navigate to the content workspace where the full row is loaded.
 *
 * Access gate: any capability that lets the user read data rows
 * (`content.*`). Callers without `content.edit.any` / `content.publish.any` /
 * `content.manage` see only their own rows — same ownership rule the
 * per-table list endpoint enforces. Without this, a slug fragment typed in
 * the spotlight palette would leak other authors' row metadata.
 */
import type { DbClient } from '../../../db/client'
import { searchDataRows } from '../../../repositories/data'
import { jsonResponse, methodNotAllowed } from '../../../http'
import { CMS_API_PREFIX } from '../shared'
import { canReadTable, canSeeAllDataRows, requireDataAccess } from './access'
import type { BranchScope } from '../../../branches/scope'

const SEARCH_PATH = `${CMS_API_PREFIX}/data/search`
const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export async function handleDataSearchRoute(
  req: Request,
  db: DbClient,
  scope: BranchScope,
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== SEARCH_PATH) return null

  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireDataAccess(req, db)
  if (user instanceof Response) return user

  const rawQuery = url.searchParams.get('query')?.trim() ?? ''
  if (!rawQuery) return jsonResponse({ entries: [] })

  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10)
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  )

  const visibility = canSeeAllDataRows(user) ? {} : { ownerUserId: user.id }
  const results = await searchDataRows(db, scope, rawQuery, limit, visibility)
  // A broad content.* capability satisfies requireDataAccess, but the search
  // must not surface system-table rows (pages/posts) to a caller without
  // data.system.tables.read (GHSA-x69h). Drop them, and keep the internal
  // table-family flag off the wire.
  const entries = results
    .filter((r) => canReadTable(user, { system: r.tableSystem }))
    .map((r) => ({
      id: r.id,
      tableId: r.tableId,
      tableSlug: r.tableSlug,
      tableName: r.tableName,
      slug: r.slug,
      status: r.status,
      updatedAt: r.updatedAt,
    }))
  return jsonResponse({ entries })
}
