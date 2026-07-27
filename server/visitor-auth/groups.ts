/**
 * Visitor member-group + membership DB CRUD (Phase 3 — D13/D14/D15).
 *
 * Extracted as its own module mirroring `./roles.ts` (which itself mirrors
 * the admin `server/repositories/roles.ts` split): this file owns the
 * `visitor_groups` table and the `visitor_user_groups` junction ONLY. Visitor
 * roles live in `./roles.ts`; users/sessions/etc. live in `./repositories.ts`.
 *
 * A group is a content-segmentation segment (page-level access — D14 — and
 * login-redirect landing — D15), orthogonal to a role (capabilities — D13).
 *
 * All SQL is ANSI-standard (no Postgres-isms — see `repositories.ts` header
 * for the full dialect rules) so the same statements run unchanged against
 * both the Postgres and SQLite adapters. `current_timestamp` is the portable
 * "now" expression. Rows map to the camelCase `VisitorGroup` / `VisitorUserGroup`
 * domain shapes through `rowTo*`; column lists are inlined into each tagged
 * template (matching `server/repositories/roles.ts`) because a
 * `db\`select ${COLS}\`` would interpolate the constant as a bind parameter,
 * not as SQL text.
 *
 * Policy: a group is always deletable — the junction CASCADEs, so deleting a
 * group also removes every membership. A visitor's `primary_group_id` is
 * `ON DELETE SET NULL`, so deleting the primary group simply clears the
 * pointer (the visitor then falls back to the default landing path on login).
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { placeholder } from '../db/client'
import type {
  VisitorGroup,
  VisitorGroupRow,
  VisitorUserGroup,
  VisitorUserGroupRow,
} from './types'

/**
 * Typed mutation error for visitor-group writes. Carries an HTTP `status`
 * (default 400) so the shared `mutationErrorResponse` handler can translate
 * it into the `{ error }` JSON envelope. Mirrors `VisitorRoleMutationError`.
 */
export class VisitorGroupMutationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'VisitorGroupMutationError'
    this.status = status
  }
}

/**
 * Derive a lowercase-kebab slug from a group name (e.g. "Founders!" →
 * "founders"). Non-alphanumeric runs collapse to a single hyphen; the result
 * is trimmed of leading/trailing hyphens. The slug is NOT unique (only
 * `name` is) — it is a human-friendly identifier for diagnostics / future
 * deep links.
 */
export function slugifyGroupName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function rowToGroup(row: VisitorGroupRow): VisitorGroup {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    landingPath: row.landing_path,
    description: row.description,
    isSystem: Boolean(row.is_system),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function rowToUserGroup(row: VisitorUserGroupRow): VisitorUserGroup {
  return {
    id: row.id,
    userId: row.user_id,
    groupId: row.group_id,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Group CRUD
// ---------------------------------------------------------------------------

export async function findVisitorGroupById(db: DbClient, id: string): Promise<VisitorGroup | null> {
  const { rows } = await db<VisitorGroupRow>`
    select id, name, slug, landing_path, description, is_system, created_at, updated_at
    from visitor_groups
    where id = ${id}
    limit 1
  `
  return rows[0] ? rowToGroup(rows[0]) : null
}

export async function findVisitorGroupByName(db: DbClient, name: string): Promise<VisitorGroup | null> {
  const { rows } = await db<VisitorGroupRow>`
    select id, name, slug, landing_path, description, is_system, created_at, updated_at
    from visitor_groups
    where name = ${name}
    limit 1
  `
  return rows[0] ? rowToGroup(rows[0]) : null
}

export async function listVisitorGroups(db: DbClient): Promise<VisitorGroup[]> {
  const { rows } = await db<VisitorGroupRow>`
    select id, name, slug, landing_path, description, is_system, created_at, updated_at
    from visitor_groups
    order by is_system desc, name asc
  `
  return rows.map(rowToGroup)
}

/**
 * Pre-check name uniqueness (excluding the row currently being edited, if
 * any) so a duplicate name surfaces a clean 409 instead of a dialect-specific
 * DB constraint violation. The `visitor_groups.name` UNIQUE constraint is the
 * backstop; this is the friendly, portable front line — same shape as the
 * role-name pre-check in `./roles.ts`.
 */
async function assertVisitorGroupNameAvailable(
  db: DbClient,
  name: string,
  currentGroupId?: string,
): Promise<void> {
  const existing = await findVisitorGroupByName(db, name)
  if (existing && existing.id !== currentGroupId) {
    throw new VisitorGroupMutationError('Visitor group name is already in use', 409)
  }
}

/** Resolve a landing path: fall back to '/' when blank. */
function resolveLandingPath(path: string | undefined): string {
  const trimmed = (path ?? '').trim()
  return trimmed || '/'
}

export interface CreateVisitorGroupInput {
  name: string
  landingPath?: string
  description?: string
}

/**
 * Create a visitor group. The slug is derived from the name; `landingPath`
 * defaults to `/`. A duplicate name is rejected up front via
 * {@link assertVisitorGroupNameAvailable} so the caller gets a 409, not a raw
 * constraint error. Custom groups are always created with `is_system = false`.
 */
export async function createVisitorGroup(
  db: DbClient,
  input: CreateVisitorGroupInput,
): Promise<VisitorGroup> {
  const name = input.name.trim()
  if (!name) throw new VisitorGroupMutationError('Visitor group name is required')
  await assertVisitorGroupNameAvailable(db, name)

  const id = nanoid()
  const slug = slugifyGroupName(name)
  const landingPath = resolveLandingPath(input.landingPath)
  const description = (input.description ?? '').trim()
  const { rows } = await db<VisitorGroupRow>`
    insert into visitor_groups (id, name, slug, landing_path, description, is_system)
    values (${id}, ${name}, ${slug}, ${landingPath}, ${description}, ${false})
    returning id, name, slug, landing_path, description, is_system, created_at, updated_at
  `
  return rowToGroup(rows[0]!)
}

export interface UpdateVisitorGroupInput {
  name?: string
  landingPath?: string
  description?: string
}

/**
 * Update a visitor group's name and/or landing path and/or description. The
 * slug is re-derived when the name changes. A rename that collides with
 * another group's name is rejected with a 409.
 */
export async function updateVisitorGroup(
  db: DbClient,
  groupId: string,
  input: UpdateVisitorGroupInput,
): Promise<VisitorGroup | null> {
  const current = await findVisitorGroupById(db, groupId)
  if (!current) return null

  const name = input.name === undefined ? current.name : input.name.trim()
  if (!name) throw new VisitorGroupMutationError('Visitor group name is required')
  await assertVisitorGroupNameAvailable(db, name, current.id)
  // Re-derive the slug whenever the name changes so it never drifts from the
  // (possibly renamed) name. Kept as a stored column purely for diagnostics.
  const slug = input.name === undefined ? current.slug : slugifyGroupName(name)
  const landingPath = input.landingPath === undefined ? current.landingPath : resolveLandingPath(input.landingPath)
  const description = input.description === undefined ? current.description : input.description.trim()

  const { rows } = await db<VisitorGroupRow>`
    update visitor_groups
    set name = ${name},
        slug = ${slug},
        landing_path = ${landingPath},
        description = ${description},
        updated_at = current_timestamp
    where id = ${groupId}
    returning id, name, slug, landing_path, description, is_system, created_at, updated_at
  `
  return rows[0] ? rowToGroup(rows[0]) : null
}

/**
 * Delete a visitor group. The `visitor_user_groups` junction CASCADEs, so
 * deleting the group also removes every membership. A visitor whose primary
 * group is the deleted row keeps browsing (the `visitor_users.primary_group_id`
 * FK is `ON DELETE SET NULL`); their next login simply falls back to the
 * configured default landing path. Returns the deleted group, or `null` when
 * no row matched `groupId`.
 */
export async function deleteVisitorGroup(db: DbClient, groupId: string): Promise<VisitorGroup | null> {
  const current = await findVisitorGroupById(db, groupId)
  if (!current) return null
  await db`delete from visitor_groups where id = ${groupId}`
  return current
}

// ---------------------------------------------------------------------------
// Membership (visitor_user_groups junction)
// ---------------------------------------------------------------------------

/**
 * The membership-set view returned by {@link listGroupsForVisitor}: the groups
 * a visitor belongs to plus whether one of them is their designated primary.
 */
export interface VisitorMembershipView {
  group: VisitorGroup
  isPrimary: boolean
}

/**
 * Add a visitor to one or more groups. Idempotent: the junction's
 * UNIQUE(user_id, group_id) means a pre-existing membership is left in place
 * (no error). Unknown group ids are silently skipped (defensive — the caller
 * is expected to have validated them, but a race-free guarantee isn't worth a
 * round-trip per id). Returns the FULL current membership set after the add.
 */
export async function addGroupsToVisitor(
  db: DbClient,
  userId: string,
  groupIds: string[],
): Promise<VisitorMembershipView[]> {
  const uniqueIds = [...new Set(groupIds)]
  if (uniqueIds.length > 0) {
    // Resolve which of the requested ids actually exist so we never insert a
    // dangling membership row (the FK would reject it anyway — this gives a
    // clean set to INSERT without per-row error handling). The shared
    // `DbClient` tagged-template form can't expand a JS array into a SQL IN
    // list, so we build the placeholder list explicitly through `placeholder()`
    // (mirrors `loadFolderIdsForAssets` in server/repositories/media.ts).
    const placeholders = uniqueIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')
    const { rows: existing } = await db.unsafe<{ id: string }>(
      `select id from visitor_groups where id in (${placeholders})`,
      uniqueIds,
    )
    const existingIds = existing.map((r) => r.id)
    for (const groupId of existingIds) {
      // ON CONFLICT keeps this idempotent across re-applies.
      await db`
        insert into visitor_user_groups (id, user_id, group_id)
        values (${nanoid()}, ${userId}, ${groupId})
        on conflict (user_id, group_id) do nothing
      `
    }
  }
  return listGroupsForVisitor(db, userId)
}

/**
 * Remove a visitor from a single group. Returns true when a row was removed.
 * Removing the visitor's primary group does NOT clear `primary_group_id`
 * here — callers that want the pointer cleared should call
 * {@link setVisitorPrimaryGroup} with `null`, or rely on the
 * `ON DELETE CASCADE` path when the whole group is deleted.
 */
export async function removeVisitorFromGroup(
  db: DbClient,
  userId: string,
  groupId: string,
): Promise<boolean> {
  const result = await db`
    delete from visitor_user_groups
    where user_id = ${userId} and group_id = ${groupId}
  `
  return result.rowCount > 0
}

/**
 * List every group a visitor belongs to, flagging the one (if any) that is
 * their designated primary group. Used by the middleware (page-access check)
 * and the admin membership endpoints.
 */
export async function listGroupsForVisitor(
  db: DbClient,
  userId: string,
): Promise<VisitorMembershipView[]> {
  const { rows } = await db<VisitorGroupRow & { is_primary: boolean | number }>`
    select g.id, g.name, g.slug, g.landing_path, g.description, g.is_system, g.created_at, g.updated_at,
           case when u.primary_group_id = g.id then 1 else 0 end as is_primary
    from visitor_groups g
    join visitor_user_groups m on m.group_id = g.id
    join visitor_users u on u.id = m.user_id
    where m.user_id = ${userId}
      and u.deleted_at is null
    order by g.name asc
  `
  return rows.map((r) => ({
    group: rowToGroup(r),
    isPrimary: Boolean(r.is_primary),
  }))
}

/**
 * Resolve a visitor to the flat list of group ids they belong to. The page-
 * access middleware's hot path — kept separate from {@link listGroupsForVisitor}
 * so it never builds the richer `VisitorMembershipView` objects.
 */
export async function listGroupIdsForVisitor(db: DbClient, userId: string): Promise<string[]> {
  const { rows } = await db<{ group_id: string }>`
    select group_id from visitor_user_groups where user_id = ${userId}
  `
  return rows.map((r) => r.group_id)
}

/**
 * List every membership row in a group (the junction side). Returns the raw
 * membership — callers join to `visitor_users` for display via the handler.
 */
export async function listMembershipsForGroup(
  db: DbClient,
  groupId: string,
): Promise<VisitorUserGroup[]> {
  const { rows } = await db<VisitorUserGroupRow>`
    select id, user_id, group_id, created_at
    from visitor_user_groups
    where group_id = ${groupId}
    order by created_at asc
  `
  return rows.map(rowToUserGroup)
}

/**
 * Set a visitor's designated primary group (D15). Pass `null` to clear it (the
 * visitor then falls back to the configured default landing path on login).
 * Setting a primary group the visitor is NOT a member of is rejected (409) —
 * the primary group must be one of the visitor's memberships.
 */
export async function setVisitorPrimaryGroup(
  db: DbClient,
  userId: string,
  groupId: string | null,
): Promise<void> {
  if (groupId !== null) {
    const { rows } = await db<{ count: number }>`
      select count(*) as count
      from visitor_user_groups
      where user_id = ${userId} and group_id = ${groupId}
    `
    if (Number(rows[0]?.count ?? 0) === 0) {
      throw new VisitorGroupMutationError(
        'Primary group must be one of the visitor\'s memberships',
        409,
      )
    }
  }
  await db`
    update visitor_users
    set primary_group_id = ${groupId},
        updated_at = current_timestamp
    where id = ${userId}
      and deleted_at is null
  `
}

/** Read a visitor's primary group id (or `null` when unset / user missing). */
export async function getVisitorPrimaryGroupId(
  db: DbClient,
  userId: string,
): Promise<string | null> {
  const { rows } = await db<{ primary_group_id: string | null }>`
    select primary_group_id from visitor_users where id = ${userId} and deleted_at is null
  `
  return rows[0]?.primary_group_id ?? null
}
