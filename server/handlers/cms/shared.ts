/**
 * Shared helpers used by every handler in `server/handlers/cms/*`.
 *
 * - `requestAuditContext` — the `(ipAddress, userAgent)` pair every audit
 *   event carries.
 * - `mutationErrorResponse` — translates the typed mutation errors thrown
 *   by repositories (`UserMutationError`, `RoleMutationError`) into the
 *   `{ error }` JSON envelope clients expect.
 * - `siteCollectionRowsResponse` — the one `{ rows }` list/single-row read
 *   shared by the pages / components / layouts GET endpoints.
 *
 * These helpers are intentionally small and dependency-free so any new
 * handler module can pull them in without dragging the rest of the CMS
 * surface along with it.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import type { CollabRelay } from '../../collab/relay'
import type { BranchScope } from '../../branches/scope'
import { jsonResponse } from '../../http'
import { clientIp } from '../../auth/security'
import { listDataRows } from '../../repositories/data'
import { UserMutationError } from '../../repositories/users'
import { RoleMutationError } from '../../repositories/roles'

export const CMS_API_PREFIX = '/admin/api/cms'

export const UserStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('suspended')])

export interface CmsHandlerOptions {
  uploadsDir?: string
  /**
   * The raw `DATABASE_URL` the server booted with. Forwarded so handlers
   * that need to resolve the on-disk SQLite file (e.g. the storage
   * dashboard widget) can do so without re-parsing `process.env`. Postgres
   * URLs are passed verbatim — handlers that care about dialect should
   * branch on `db.dialect` instead of inspecting the URL themselves.
   */
  databaseUrl?: string
  /**
   * The live collab relay. Branch deletion evicts the branch's resident
   * documents through it so an in-flight persist cannot resurrect a blob
   * after the rows are gone. Absent in handler tests that run without one.
   */
  collabRelay?: CollabRelay
}

/**
 * Audit fields extracted from the HTTP request. `null` covers actions with
 * no request — e.g. AI-tool-initiated lifecycle operations, where the actor
 * is recorded but there is no client ip/ua to attribute.
 */
export function requestAuditContext(req: Request | null): { ipAddress: string | null; userAgent: string | null } {
  if (!req) return { ipAddress: null, userAgent: null }
  return {
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  }
}

/**
 * `{ rows }` response for one of the three site collection GETs
 * (pages / components / layouts).
 */
export async function siteCollectionRowsResponse(
  db: DbClient,
  scope: BranchScope,
  tableId: 'pages' | 'components' | 'layouts',
): Promise<Response> {
  return jsonResponse({ rows: await listDataRows(db, scope, tableId) })
}

export function mutationErrorResponse(err: unknown): Response {
  if (err instanceof UserMutationError || err instanceof RoleMutationError) {
    return jsonResponse({ error: err.message }, { status: err.status })
  }
  throw err
}
