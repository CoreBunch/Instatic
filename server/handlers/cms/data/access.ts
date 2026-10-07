/**
 * Capability guards for data table and row endpoints.
 *
 * Two capability families:
 *
 *   content.*  — row-level editorial: who can create / edit / publish rows,
 *                including the own-vs-any split. Drives the Content
 *                workspace and the per-row gating in the Data grid.
 *
 *     content.create       — create new rows
 *     content.edit.own     — read / edit own rows
 *     content.edit.any     — read / edit all rows
 *     content.publish.own  — publish own rows
 *     content.publish.any  — publish all rows
 *     content.manage       — every row operation (super-set of the above)
 *
 *   data.*     — structural / workspace-level: schema design, cross-table
 *                row moves, bundle export/import. Decoupled from `content.*`
 *                so a "data architect" persona can design tables without
 *                being able to read/write row content.
 *
 *     data.custom.tables.read    — see + browse custom tables
 *     data.custom.tables.manage  — create/rename/delete custom tables, edit fields
 *     data.system.tables.read    — see + open the 4 system tables
 *     data.system.tables.manage  — add custom fields + set primary field on a
 *                                  system table (identity + built-ins frozen)
 *     data.rows.move       — cross-collection row move
 *     data.export          — bundle export + import preview (read-only)
 *     data.import          — bundle import (replace mode also needs
 *                            `content.manage` AND step-up)
 */
import type { CoreCapability } from '../../../auth/capabilities'
import {
  requireAnyCapability,
  requireCapability,
  userHasAnyCapability,
  userHasCapability,
} from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { jsonResponse } from '../../../http'
import type { AuthUser } from '../../../repositories/users'
import type { DataTable } from '@core/data/schemas'

const DATA_ACCESS_CAPABILITIES = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_ANY_VISIBILITY_CAPABILITIES = [
  'content.edit.any',
  'content.publish.any',
  'content.manage',
] satisfies CoreCapability[]

const DATA_OWN_READ_CAPABILITIES = [
  'content.edit.own',
  'content.publish.own',
] satisfies CoreCapability[]

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

/**
 * Who is asking. The predicates below take the caller's identity + capability
 * set rather than a whole `AuthUser` so the AI tool handlers can reuse them:
 * a tool has a `ToolContext` (userId + capabilities), never an `AuthUser`, and
 * a second copy of these rules on that side would be free to drift from this
 * one. See `server/ai/tools/data/access.ts`.
 */
type DataRowActor = Pick<AuthUser, 'id' | 'capabilities'>

interface OwnedDataRow {
  authorUserId: string | null
  createdByUserId: string | null
}

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
 * Whether the user may SEE a specific table. System tables need a system read
 * cap; custom tables need a custom read cap. Used to filter the table list and
 * gate single-table reads at the boundary.
 */
export function canReadTable(user: Pick<AuthUser, 'capabilities'>, table: Pick<DataTable, 'system'>): boolean {
  return table.system
    ? userHasAnyCapability(user, ['data.system.tables.read', 'data.system.tables.manage'])
    : userHasAnyCapability(user, ['data.custom.tables.read', 'data.custom.tables.manage'])
}

/**
 * Whether the user may MANAGE a specific table's schema. For system tables this
 * only governs custom fields + primary-field selection — identity and built-in
 * fields are immutable for everyone (`assertSystemTableUpdateAllowed`).
 */
export function canManageTable(user: Pick<AuthUser, 'capabilities'>, table: Pick<DataTable, 'system'>): boolean {
  return userHasCapability(user, table.system ? 'data.system.tables.manage' : 'data.custom.tables.manage')
}

/**
 * Content-row access (the loop / template pickers in the site editor). Such a
 * caller sees the full table list even without data-table read caps, because
 * picking a loop source needs to know what tables exist.
 */
export function hasContentRowAccess(user: Pick<AuthUser, 'capabilities'>): boolean {
  return userHasAnyCapability(user, DATA_ACCESS_CAPABILITIES)
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

export function canSeeAllDataRows(user: AuthUser): boolean {
  return userHasAnyCapability(user, DATA_ANY_VISIBILITY_CAPABILITIES)
}

function ownsDataRow(user: Pick<AuthUser, 'id'>, row: OwnedDataRow): boolean {
  return row.authorUserId === user.id || (!row.authorUserId && row.createdByUserId === user.id)
}

export function canReadDataRow(user: AuthUser, row: OwnedDataRow): boolean {
  return canSeeAllDataRows(user) ||
    (ownsDataRow(user, row) && userHasAnyCapability(user, DATA_OWN_READ_CAPABILITIES))
}

export function canEditDataRow(user: DataRowActor, row: OwnedDataRow): boolean {
  return userHasAnyCapability(user, ['content.edit.any', 'content.manage']) ||
    (ownsDataRow(user, row) && userHasCapability(user, 'content.edit.own'))
}

export function canPublishDataRow(user: DataRowActor, row: OwnedDataRow): boolean {
  return userHasCapability(user, 'content.publish.any') ||
    (ownsDataRow(user, row) && userHasCapability(user, 'content.publish.own'))
}
