/**
 * HTTP capability guards for the data table and row endpoints.
 *
 * The decision logic (which table families and rows a principal may touch)
 * lives in `server/auth/dataAccess.ts`, shared with the AI read tools and
 * the MCP relay. This module only binds those decisions to a request: it
 * resolves the session user and answers with the HTTP status the data
 * workspace expects.
 */
import type { CoreCapability } from '../../../auth/capabilities'
import { requireAnyCapability, requireCapability } from '../../../auth/authz'
import { DATA_ACCESS_CAPABILITIES } from '../../../auth/dataAccess'
import type { DbClient } from '../../../db/client'
import { jsonResponse } from '../../../http'
import type { AuthUser } from '../../../repositories/users'

const DATA_EDIT_CAPABILITIES = [
  'content.edit.own',
  'content.edit.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_REASSIGN_CAPABILITIES = [
  'content.edit.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_PUBLISH_CAPABILITIES = [
  'content.publish.own',
  'content.publish.any',
] satisfies CoreCapability[]

export function forbidden(): Response {
  return jsonResponse({ error: 'Forbidden' }, { status: 403 })
}

export async function requireDataAccess(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_ACCESS_CAPABILITIES)
}

// Any data-table read/manage cap is enough to OPEN the Data workspace; the
// list endpoint then filters tables per-family via `canReadTable`.
const TABLE_READ_CAPABILITIES = [
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
] satisfies CoreCapability[]

/**
 * Schema-level read floor — open the Data workspace. Holding ANY table
 * read/manage cap (custom or system) is sufficient to enter; per-table
 * visibility is decided by `canReadTable`.
 */
export async function requireDataTablesRead(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, TABLE_READ_CAPABILITIES)
}

/**
 * Create a CUSTOM table. System tables are seeded, never created, so creation
 * always gates on the custom-manage cap.
 */
export async function requireCustomTablesManager(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireCapability(req, db, 'data.custom.tables.manage')
}

/**
 * Cross-collection row move — `PATCH /data/rows/:id/table`. Split out
 * because moving a row to a different table changes its public URL
 * (different route base) and is structurally distinct from editing a
 * row's cells.
 */
export async function requireDataRowMover(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireCapability(req, db, 'data.rows.move')
}

export async function requireDataEditor(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_EDIT_CAPABILITIES)
}

export async function requireDataCreator(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireCapability(req, db, 'content.create')
}

export async function requireDataAuthorManager(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_REASSIGN_CAPABILITIES)
}

export async function requireDataPublisher(req: Request, db: DbClient): Promise<AuthUser | Response> {
  return requireAnyCapability(req, db, DATA_PUBLISH_CAPABILITIES)
}
