/**
 * Visitor-role DB CRUD.
 *
 * Extracted from `repositories.ts` (which mixed roles / users / sessions /
 * login attempts / password-reset tokens) so each concern owns its own
 * module — mirroring the admin system, where `server/repositories/roles.ts`
 * is its own file separate from `users.ts`. Everything here is read/write
 * against the `visitor_roles` table only.
 *
 * All SQL is ANSI-standard (no Postgres-isms — see `repositories.ts` header
 * for the full dialect rules) so the same statements run unchanged against
 * both the Postgres and SQLite adapters. Rows map to the camelCase
 * `VisitorRole` domain shape through `rowToRole`; the column list is inlined
 * into each tagged template (matching `server/repositories/roles.ts`) because
 * a `db\`select ${COLS}\`` would interpolate the constant as a bind
 * parameter, not as SQL text.
 *
 * Policy: system roles (`member` / `admin`) MAY be edited (name +
 * capabilities) but NEVER deleted; custom roles may be edited and (when no
 * active visitor is assigned to them) deleted. There is no Owner-lock
 * concept (unlike the admin role system).
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { filterArray, Type } from '@core/utils/typeboxHelpers'
import type { VisitorRole, VisitorRoleRow } from './types'

// Capabilities for visitor roles are free-form strings (Phase-1 simplification
// — no junction table, no enum). `filterArray` keeps corrupt column data from
// crashing the read while staying inside the whitelisted
// `@core/utils/typeboxHelpers` surface.
const VisitorCapabilitySchema = Type.String()

function rowToRole(row: VisitorRoleRow): VisitorRole {
  return {
    id: row.id,
    name: row.name,
    capabilities: filterArray(VisitorCapabilitySchema, row.capabilities_json),
    isSystem: Boolean(row.is_system),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/**
 * Typed mutation error for visitor-role writes. Carries an HTTP `status`
 * (default 400) so the shared `mutationErrorResponse` handler can translate
 * it into the `{ error }` JSON envelope without the handler hard-coding the
 * status. Mirrors `RoleMutationError` in `server/repositories/roles.ts`.
 */
export class VisitorRoleMutationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'VisitorRoleMutationError'
    this.status = status
  }
}

export async function findVisitorRoleById(db: DbClient, id: string): Promise<VisitorRole | null> {
  const { rows } = await db<VisitorRoleRow>`
    select id, name, capabilities_json, is_system, created_at, updated_at
    from visitor_roles
    where id = ${id}
    limit 1
  `
  return rows[0] ? rowToRole(rows[0]) : null
}

export async function findVisitorRoleByName(db: DbClient, name: string): Promise<VisitorRole | null> {
  const { rows } = await db<VisitorRoleRow>`
    select id, name, capabilities_json, is_system, created_at, updated_at
    from visitor_roles
    where name = ${name}
    limit 1
  `
  return rows[0] ? rowToRole(rows[0]) : null
}

export async function listVisitorRoles(db: DbClient): Promise<VisitorRole[]> {
  const { rows } = await db<VisitorRoleRow>`
    select id, name, capabilities_json, is_system, created_at, updated_at
    from visitor_roles
    order by is_system desc, name asc
  `
  return rows.map(rowToRole)
}

/**
 * Pre-check name uniqueness (excluding the row currently being edited, if
 * any) so a duplicate name surfaces a clean 409 instead of a dialect-specific
 * DB constraint violation. The `visitor_roles.name` UNIQUE constraint is the
 * backstop; this is the friendly, portable front line — same shape as the
 * admin `assertRoleSlugAvailable`.
 */
async function assertVisitorRoleNameAvailable(
  db: DbClient,
  name: string,
  currentRoleId?: string,
): Promise<void> {
  const existing = await findVisitorRoleByName(db, name)
  if (existing && existing.id !== currentRoleId) {
    throw new VisitorRoleMutationError('Visitor role name is already in use', 409)
  }
}

/**
 * Create a custom visitor role. Mirrors the admin `createCustomRole` shape
 * (minus slug/description — visitor roles only carry name + capabilities).
 *
 * Policy: a duplicate name is rejected up front via
 * {@link assertVisitorRoleNameAvailable} so the caller gets a 409, not a raw
 * constraint error. Custom roles are always created with `is_system = false`.
 */
export async function createVisitorRole(
  db: DbClient,
  input: { name: string; capabilities: string[] },
): Promise<VisitorRole> {
  const name = input.name.trim()
  if (!name) throw new VisitorRoleMutationError('Visitor role name is required')
  await assertVisitorRoleNameAvailable(db, name)

  const id = nanoid()
  const { rows } = await db<VisitorRoleRow>`
    insert into visitor_roles (id, name, capabilities_json, is_system)
    values (${id}, ${name}, ${input.capabilities}, ${false})
    returning id, name, capabilities_json, is_system, created_at, updated_at
  `
  return rowToRole(rows[0]!)
}

/**
 * Update a visitor role's name and/or capabilities.
 *
 * Policy (mirror the admin `roles.ts` rules, simplified — visitor roles have
 * no Owner-lock concept): system roles (`member` / `admin`) MAY be edited
 * (name + capabilities); they are NEVER deletable (see {@link deleteVisitorRole}).
 * Custom roles may be edited and (when unassigned) deleted. A rename that
 * collides with another role's name is rejected with a 409.
 */
export async function updateVisitorRole(
  db: DbClient,
  roleId: string,
  input: { name?: string; capabilities?: string[] },
): Promise<VisitorRole | null> {
  const current = await findVisitorRoleById(db, roleId)
  if (!current) return null

  const name = input.name === undefined ? current.name : input.name.trim()
  if (!name) throw new VisitorRoleMutationError('Visitor role name is required')
  await assertVisitorRoleNameAvailable(db, name, current.id)
  const capabilities = input.capabilities ?? current.capabilities

  const { rows } = await db<VisitorRoleRow>`
    update visitor_roles
    set name = ${name},
        capabilities_json = ${capabilities},
        updated_at = current_timestamp
    where id = ${roleId}
    returning id, name, capabilities_json, is_system, created_at, updated_at
  `
  return rows[0] ? rowToRole(rows[0]) : null
}

/**
 * Delete a visitor role.
 *
 * Policy: system roles are never deletable (409); custom roles are deletable
 * only when no active visitor is assigned to them (409 otherwise — the
 * `visitor_users.role_id` FK is `on delete restrict`, so this guard turns the
 * restriction into a friendly message instead of a 500). Returns the deleted
 * role on success, or `null` when no row matched `roleId`.
 */
export async function deleteVisitorRole(db: DbClient, roleId: string): Promise<VisitorRole | null> {
  const current = await findVisitorRoleById(db, roleId)
  if (!current) return null
  if (current.isSystem) {
    throw new VisitorRoleMutationError('System roles cannot be deleted', 409)
  }

  const { rows } = await db<{ count: number }>`
    select count(*) as count
    from visitor_users
    where role_id = ${roleId}
      and deleted_at is null
  `
  if (Number(rows[0]?.count ?? 0) > 0) {
    throw new VisitorRoleMutationError('Cannot delete a role assigned to visitors', 409)
  }

  const result = await db`delete from visitor_roles where id = ${roleId}`
  return result.rowCount > 0 ? current : null
}
