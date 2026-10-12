/**
 * Table-family and row-ownership authorization for data rows, shared by
 * every server-side reader and writer: the HTTP data handlers, the AI read
 * tools, and the MCP relay. One module decides who may see a table and who
 * may read, edit, or publish a row, so no caller can re-derive the rule and
 * drift (GHSA-x69h, GHSA-m425, GHSA-x5cc all came from a second copy or a
 * skipped call).
 *
 * Two capability families:
 *
 *   content.*  — row-level editorial: who can create / edit / publish rows,
 *                including the own-vs-any split.
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
 *
 * A principal is anything that carries a user id and a capability set: the
 * session user on an HTTP request, or the connector identity behind an AI
 * tool call. Row predicates never need more than that.
 */
import type { CoreCapability } from './capabilities'
import { userHasAnyCapability, userHasCapability } from './authz'
import type { DbClient } from '../db/client'
import type { BranchScope } from '../branches/scope'
import { getDataRow, getDataTable } from '../repositories/data'
import type { DataRow, DataTable } from '@core/data/schemas'

export interface DataPrincipal {
  id: string
  capabilities: readonly CoreCapability[]
}

export const DATA_ACCESS_CAPABILITIES = [
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

export interface OwnedDataRow {
  authorUserId: string | null
  createdByUserId: string | null
}

/**
 * Whether the principal may SEE a specific table. System tables need a system
 * read cap; custom tables need a custom read cap. Filters the table list and
 * gates every single-table and single-row read at the boundary.
 */
export function canReadTable(principal: DataPrincipal, table: Pick<DataTable, 'system'>): boolean {
  return table.system
    ? userHasAnyCapability(principal, ['data.system.tables.read', 'data.system.tables.manage'])
    : userHasAnyCapability(principal, ['data.custom.tables.read', 'data.custom.tables.manage'])
}

/**
 * Whether the principal may MANAGE a specific table's schema. For system
 * tables this only governs custom fields + primary-field selection; identity
 * and built-in fields are immutable for everyone.
 */
export function canManageTable(principal: DataPrincipal, table: Pick<DataTable, 'system'>): boolean {
  return userHasCapability(principal, table.system ? 'data.system.tables.manage' : 'data.custom.tables.manage')
}

/**
 * Content-row access (the loop / template pickers in the site editor). Such a
 * caller sees the full table list even without data-table read caps, because
 * picking a loop source needs to know what tables exist.
 */
export function hasContentRowAccess(principal: DataPrincipal): boolean {
  return userHasAnyCapability(principal, DATA_ACCESS_CAPABILITIES)
}

export function canSeeAllDataRows(principal: DataPrincipal): boolean {
  return userHasAnyCapability(principal, DATA_ANY_VISIBILITY_CAPABILITIES)
}

/**
 * The repository visibility filter for list and search reads: everything for
 * a principal with any-row visibility, otherwise only the rows it owns.
 */
export function rowVisibilityFor(principal: DataPrincipal): { ownerUserId?: string } {
  return canSeeAllDataRows(principal) ? {} : { ownerUserId: principal.id }
}

function ownsDataRow(principal: DataPrincipal, row: OwnedDataRow): boolean {
  return row.authorUserId === principal.id || (!row.authorUserId && row.createdByUserId === principal.id)
}

export function canReadDataRow(principal: DataPrincipal, row: OwnedDataRow): boolean {
  return canSeeAllDataRows(principal) ||
    (ownsDataRow(principal, row) && userHasAnyCapability(principal, DATA_OWN_READ_CAPABILITIES))
}

export function canEditDataRow(principal: DataPrincipal, row: OwnedDataRow): boolean {
  return userHasAnyCapability(principal, ['content.edit.any', 'content.manage']) ||
    (ownsDataRow(principal, row) && userHasCapability(principal, 'content.edit.own'))
}

export function canPublishDataRow(principal: DataPrincipal, row: OwnedDataRow): boolean {
  return userHasCapability(principal, 'content.publish.any') ||
    (ownsDataRow(principal, row) && userHasCapability(principal, 'content.publish.own'))
}

/** A row-level permission predicate: `canReadDataRow`, `canEditDataRow`, or `canPublishDataRow`. */
export type RowCheck = (principal: DataPrincipal, row: OwnedDataRow) => boolean

export type RowAccess =
  | { kind: 'ok'; row: DataRow; table: DataTable }
  /** The row does not exist, or lives in a table family the principal cannot see. Callers answer "not found" so the id leaks nothing. */
  | { kind: 'not-found' }
  /** The row is visible but the requested operation is not permitted on it. */
  | { kind: 'forbidden'; row: DataRow; table: DataTable }

/**
 * Resolve one row for a principal and an operation. Enforces the table-family
 * read boundary BEFORE the row-ownership check: a persona granted a broad
 * content.* capability but NOT data.system.tables.read satisfies ownership on
 * every row, so without the table gate it could read, edit, and publish
 * system-table rows (pages/posts drafts, author identity).
 */
export async function resolveRowAccess(
  db: DbClient,
  scope: BranchScope,
  rowId: string,
  principal: DataPrincipal,
  check: RowCheck,
): Promise<RowAccess> {
  const row = await getDataRow(db, scope, rowId)
  if (!row) return { kind: 'not-found' }
  const table = await getDataTable(db, scope, row.tableId)
  if (!table || !canReadTable(principal, table)) return { kind: 'not-found' }
  if (!check(principal, row)) return { kind: 'forbidden', row, table }
  return { kind: 'ok', row, table }
}
