/**
 * Visitor-auth admin endpoints (gated by `users.manage`).
 *
 * Lets an admin enable/disable visitor auth, configure protected prefixes,
 * and manage registered visitor accounts (list, suspend/activate, change
 * role, soft-delete). All under `/admin/api/cms/visitor-auth/*`.
 *
 *   GET    /admin/api/cms/visitor-auth/config   — current visitor-auth config
 *   PUT    /admin/api/cms/visitor-auth/config   — save (merge-patch) the config
 *   GET    /admin/api/cms/visitor-auth/roles    — list visitor roles (for the
 *                                                  role-picker in the users table)
 *   POST   /admin/api/cms/visitor-auth/roles    — create a custom visitor role
 *   PATCH  /admin/api/cms/visitor-auth/roles/:id — rename / re-cap a visitor role
 *   DELETE /admin/api/cms/visitor-auth/roles/:id — delete a custom visitor role
 *   GET    /admin/api/cms/visitor-auth/users    — paginated visitor list
 *                                                  (?search=&limit=&offset=)
 *   PATCH  /admin/api/cms/visitor-auth/users/:id — update status / role / displayName
 *   DELETE /admin/api/cms/visitor-auth/users/:id — soft delete (+ revoke sessions)
 *
 * CSRF: the CMS entry point (`./index.ts`) already rejects state-changing
 * requests whose Origin doesn't match before any route group runs, so the
 * PUT/PATCH/DELETE handlers here are CSRF-protected by the time they execute.
 *
 * Capability reuse: visitor management is gated by `users.manage` (the same
 * capability that gates admin user management). Adding a dedicated
 * `visitorAuth.manage` capability is deferred — it would require editing the
 * core capability list + every SYSTEM_ROLE grant, and for Phase 1 "can manage
 * users → can manage visitor users" is the right call.
 *
 * Audit: role CRUD (POST/PATCH/DELETE /roles) is intentionally NOT audited
 * in this task — the `AuditAction` union (`server/repositories/audit.ts`)
 * has no `visitor_auth.role_*` actions and widening it is out of scope here.
 * Visitor-user mutations (`visitor_auth.user_updated` / `_deleted`) are still
 * audited below. Adding dedicated `visitor_auth.role_created` /
 * `_updated` / `_deleted` actions is a tracked follow-up.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { createAuditEvent } from '../../repositories/audit'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import {
  CMS_API_PREFIX,
  UserStatusSchema,
  mutationErrorResponse,
  requestAuditContext,
} from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'
import {
  getVisitorAuthConfig,
  saveVisitorAuthConfig,
} from '../../visitor-auth/config'
import {
  countVisitorUsers,
  findVisitorUserById,
  listVisitorUsers,
  revokeAllVisitorSessionsForUser,
  setVisitorUserStatus,
  softDeleteVisitorUser,
  updateVisitorUserDisplayName,
  updateVisitorUserProfileFields,
  updateVisitorUserRole,
} from '../../visitor-auth/repositories'
import {
  createVisitorRole,
  deleteVisitorRole,
  findVisitorRoleById,
  listVisitorRoles,
  updateVisitorRole,
} from '../../visitor-auth/roles'
import {
  addGroupsToVisitor,
  createVisitorGroup,
  deleteVisitorGroup,
  findVisitorGroupById,
  listGroupsForVisitor,
  listMembershipsForGroup,
  listVisitorGroups,
  removeVisitorFromGroup,
  setVisitorPrimaryGroup,
  updateVisitorGroup,
  type VisitorMembershipView,
} from '../../visitor-auth/groups'
import type { VisitorUser } from '../../visitor-auth/types'

const PREFIX = `${CMS_API_PREFIX}/visitor-auth`

// ─── Config ──────────────────────────────────────────────────────────────────

const VisitorProfileFieldSchema = Type.Object({
  id: Type.String({ maxLength: 100 }),
  label: Type.String({ maxLength: 200 }),
  type: Type.Union([
    Type.Literal('text'),
    Type.Literal('longText'),
    Type.Literal('select'),
    Type.Literal('boolean'),
  ]),
  required: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(Type.Object({
    value: Type.String({ maxLength: 100 }),
    label: Type.String({ maxLength: 200 }),
  }))),
})

const VisitorAuthConfigPatchSchema = Type.Partial(Type.Object({
  enabled: Type.Boolean(),
  // D15: default landing path for a logged-in visitor with no primary-group
  // landing. Replaces the retired Phase-1/2 `protectedPrefixes` (page access
  // is now per-page, D14). A legacy `protectedPrefixes` field sent by an
  // older admin UI is ignored silently — see handlePutConfig.
  defaultLandingPath: Type.String({ maxLength: 200 }),
  loginPath: Type.String({ maxLength: 200 }),
  registrationOpen: Type.Boolean(),
  defaultRole: Type.String({ maxLength: 100 }),
  // Per-visitor-data framework: site-builder-defined custom profile field
  // DEFINITIONS (DataField[]-shape). Stored on visitor_auth_config and
  // mirrored on each visitor's profile_fields_json by id. Passed straight
  // through to saveVisitorAuthConfig (config.ts normalises/validates).
  profileFields: Type.Array(VisitorProfileFieldSchema),
}))

/**
 * Validate + clean a landing path. Returns the trimmed value, or `null` when
 * it doesn't start with `/` (keeps the login-redirect resolver sane; a bare
 * "members" would be treated as a relative path). Only call this when the
 * caller has already confirmed `defaultLandingPath !== undefined`.
 */
function normalizeLandingPath(raw: string): string | null {
  const cleaned = raw.trim()
  if (!cleaned.startsWith('/')) return null
  return cleaned
}

async function handleGetConfig(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const config = await getVisitorAuthConfig(db)
  return jsonResponse({ config })
}

async function handlePutConfig(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor

  const body = await readValidatedBody(req, VisitorAuthConfigPatchSchema)
  if (!body) return badRequest('invalid_request')

  // D14 retired `protectedPrefixes` (page access is now per-page). An older
  // admin UI may still send it briefly — ignore it silently with a one-line
  // deprecation rather than erroring, so the upgrade path is smooth.
  if ((body as Record<string, unknown>).protectedPrefixes !== undefined) {
    console.warn('[visitor-auth] ignoring deprecated protectedPrefixes in config save')
  }

  const patch = { ...body }
  // `defaultRole` must resolve to a real visitor role when supplied.
  if (body.defaultRole !== undefined) {
    const byName = await listVisitorRoles(db)
    const exists = byName.some((r) => r.id === body.defaultRole || r.name === body.defaultRole)
    if (!exists) return badRequest('unknown defaultRole')
  }
  if (body.defaultLandingPath !== undefined) {
    const landing = normalizeLandingPath(body.defaultLandingPath)
    if (landing === null) {
      return badRequest('defaultLandingPath must start with "/"')
    }
    patch.defaultLandingPath = landing
  }
  const config = await saveVisitorAuthConfig(db, patch)

  await createAuditEvent(db, {
    actorUserId: actor.id,
    action: 'visitor_auth.config_updated',
    targetType: 'site',
    targetId: 'default',
    // AuditMetadata values are primitives/string[]; nest the config object as JSON.
    metadata: { config: JSON.stringify(config) },
    ...requestAuditContext(req),
  })

  return jsonResponse({ config })
}

// ─── Roles ───────────────────────────────────────────────────────────────────

async function handleListRoles(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const roles = await listVisitorRoles(db)
  return jsonResponse({ roles })
}

const VisitorRoleCreateBodySchema = Type.Object({
  name: Type.String({ maxLength: 100 }),
  capabilities: Type.Array(Type.String()),
})

const VisitorRolePatchBodySchema = Type.Partial(Type.Object({
  name: Type.String({ maxLength: 100 }),
  capabilities: Type.Array(Type.String()),
}))

/**
 * Create a custom visitor role. Rejects a duplicate name with 409 (handled
 * via `mutationErrorResponse` from the `VisitorRoleMutationError` thrown by
 * the repository). Not audited — see the module header.
 */
async function handleCreateRole(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const body = await readValidatedBody(req, VisitorRoleCreateBodySchema)
  if (!body) return badRequest('Invalid visitor role payload')
  try {
    const role = await createVisitorRole(db, {
      name: body.name,
      capabilities: body.capabilities,
    })
    return jsonResponse({ role }, { status: 201 })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

/**
 * Update a visitor role's name and/or capabilities. System roles are
 * editable (the repository permits it — only `delete` is gated on
 * `is_system`). Not audited — see the module header.
 */
async function handleUpdateRole(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const body = await readValidatedBody(req, VisitorRolePatchBodySchema)
  if (!body) return badRequest('Invalid visitor role payload')
  try {
    const role = await updateVisitorRole(db, params.id, {
      name: body.name,
      capabilities: body.capabilities,
    })
    if (!role) return jsonResponse({ error: 'Visitor role not found' }, { status: 404 })
    return jsonResponse({ role })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

/**
 * Delete a visitor role. System roles (409) and roles still assigned to
 * visitors (409) are refused by the repository. Not audited — see the
 * module header.
 */
async function handleDeleteRole(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  try {
    const deletedRole = await deleteVisitorRole(db, params.id)
    if (!deletedRole) return jsonResponse({ error: 'Visitor role not found' }, { status: 404 })
    return jsonResponse({ role: deletedRole })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

// ─── Groups (Phase 3 — D13/D14/D15) ────────────────────────────────

const VisitorGroupCreateBodySchema = Type.Object({
  name: Type.String({ maxLength: 100 }),
  landingPath: Type.Optional(Type.String({ maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
})

const VisitorGroupPatchBodySchema = Type.Partial(Type.Object({
  name: Type.String({ maxLength: 100 }),
  landingPath: Type.Optional(Type.String({ maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
}))

async function handleListGroups(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const groups = await listVisitorGroups(db)
  return jsonResponse({ groups })
}

async function handleCreateGroup(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const body = await readValidatedBody(req, VisitorGroupCreateBodySchema)
  if (!body) return badRequest('Invalid visitor group payload')
  try {
    const group = await createVisitorGroup(db, {
      name: body.name,
      landingPath: body.landingPath,
      description: body.description,
    })
    return jsonResponse({ group }, { status: 201 })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

async function handleUpdateGroup(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const body = await readValidatedBody(req, VisitorGroupPatchBodySchema)
  if (!body) return badRequest('Invalid visitor group payload')
  try {
    const group = await updateVisitorGroup(db, params.id, {
      name: body.name,
      landingPath: body.landingPath,
      description: body.description,
    })
    if (!group) return jsonResponse({ error: 'Visitor group not found' }, { status: 404 })
    return jsonResponse({ group })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

async function handleDeleteGroup(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  try {
    const deletedGroup = await deleteVisitorGroup(db, params.id)
    if (!deletedGroup) return jsonResponse({ error: 'Visitor group not found' }, { status: 404 })
    return jsonResponse({ group: deletedGroup })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

/** Shape of a membership row joined with the visitor for the group-members list. */
interface GroupMemberRow {
  userId: string
  groupId: string
  isPrimary: boolean
  joinedAt: string
}

/**
 * GET /groups/:id/members — list the visitors in a group. Joins the junction
 * to visitor_users for display, flagging each row whose primary group is this
 * group. Returns 404 for an unknown group id.
 */
async function handleListGroupMembers(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const group = await findVisitorGroupById(db, params.id)
  if (!group) return jsonResponse({ error: 'Visitor group not found' }, { status: 404 })
  const memberships = await listMembershipsForGroup(db, params.id)
  const users = await Promise.all(
    memberships.map((m) => findVisitorUserById(db, m.userId)),
  )
  const members: GroupMemberRow[] = []
  for (const [i, m] of memberships.entries()) {
    const user = users[i]
    if (!user) continue // soft-deleted between the two reads — skip
    members.push({
      userId: user.id,
      groupId: group.id,
      isPrimary: user.primaryGroupId === group.id,
      joinedAt: m.createdAt,
    })
  }
  return jsonResponse({ group, members })
}

const VisitorUserGroupsBodySchema = Type.Object({
  groupIds: Type.Array(Type.String()),
  primaryGroupId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/**
 * PUT /users/:id/groups — set a visitor's group memberships (replaces the
 * existing set) and optionally their primary group. `primaryGroupId: null`
 * clears the primary; an omitted `primaryGroupId` leaves it untouched. Setting
 * a primary group that is NOT in the (post-write) membership set is rejected
 * (409) by the repository.
 */
async function handlePutUserGroups(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const user = await findVisitorUserById(db, params.id)
  if (!user) return jsonResponse({ error: 'visitor not found' }, { status: 404 })

  const body = await readValidatedBody(req, VisitorUserGroupsBodySchema)
  if (!body) return badRequest('invalid_request')

  // Reconcile memberships: remove groups no longer in the set, add new ones.
  const desired = new Set(body.groupIds)
  const current = await listGroupsForVisitor(db, params.id)
  for (const membership of current) {
    if (!desired.has(membership.group.id)) {
      await removeVisitorFromGroup(db, params.id, membership.group.id)
    }
  }
  await addGroupsToVisitor(db, params.id, body.groupIds)

  if (body.primaryGroupId !== undefined) {
    try {
      await setVisitorPrimaryGroup(db, params.id, body.primaryGroupId)
    } catch (err) {
      return mutationErrorResponse(err)
    }
  }

  await createAuditEvent(db, {
    actorUserId: actor.id,
    action: 'visitor_auth.user_updated',
    targetType: 'user',
    targetId: params.id,
    metadata: { email: user.email, changes: JSON.stringify({ groups: body.groupIds, primaryGroupId: body.primaryGroupId ?? null }) },
    ...requestAuditContext(req),
  })

  const memberships: VisitorMembershipView[] = await listGroupsForVisitor(db, params.id)
  return jsonResponse({ userId: params.id, memberships })
}

async function handleGetUserGroups(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const user = await findVisitorUserById(db, params.id)
  if (!user) return jsonResponse({ error: 'visitor not found' }, { status: 404 })
  const memberships: VisitorMembershipView[] = await listGroupsForVisitor(db, params.id)
  return jsonResponse({ userId: params.id, memberships })
}

// ─── Users ──────────────────────────────────────────────────────────────

/** The admin-facing visitor shape — never exposes `passwordHash`. */
function toAdminVisitor(db: DbClient, user: VisitorUser): Promise<{
  id: string
  email: string
  displayName: string
  roleId: string
  roleName: string
  status: string
  failedLoginCount: number
  lockedUntil: string | null
  createdAt: string
  // Per-visitor-data framework: custom profile field VALUES.
  profileFields: Record<string, unknown>
}> {
  return findVisitorRoleById(db, user.roleId).then((role) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roleId: user.roleId,
    roleName: role?.name ?? user.roleId,
    status: user.status,
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil,
    createdAt: user.createdAt,
    profileFields: user.profileFields,
  }))
}

async function handleListUsers(req: Request, db: DbClient): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor
  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? '50')
  const offset = Number(url.searchParams.get('offset') ?? '0')
  const search = url.searchParams.get('search') ?? undefined
  const [users, total] = await Promise.all([
    listVisitorUsers(db, {
      limit: Number.isFinite(limit) ? limit : undefined,
      offset: Number.isFinite(offset) ? offset : undefined,
      search: search || undefined,
    }),
    countVisitorUsers(db, { search: search || undefined }),
  ])
  const items = await Promise.all(users.map((u) => toAdminVisitor(db, u)))
  return jsonResponse({ users: items, total })
}

const VisitorUserPatchSchema = Type.Partial(Type.Object({
  status: UserStatusSchema,
  roleId: Type.String(),
  displayName: Type.String({ maxLength: 200 }),
  // Per-visitor-data framework: custom profile field VALUES (object keyed by
  // field id). Stored whole — callers merge against existing values. The id
  // keys should match the configured VisitorProfileField defs, but the server
  // doesn't enforce that (allows ad-hoc values during config transitions).
  profileFields: Type.Record(Type.String(), Type.Unknown()),
}))

async function handlePatchUser(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor

  const current = await findVisitorUserById(db, params.id)
  if (!current) return jsonResponse({ error: 'visitor not found' }, { status: 404 })

  const body = await readValidatedBody(req, VisitorUserPatchSchema)
  if (!body) return badRequest('invalid_request')

  // Validate roleId if supplied.
  if (body.roleId !== undefined && body.roleId !== current.roleId) {
    const role = await findVisitorRoleById(db, body.roleId)
    if (!role) return badRequest('unknown roleId')
  }

  if (body.displayName !== undefined && body.displayName !== current.displayName) {
    await updateVisitorUserDisplayName(db, params.id, body.displayName)
  }
  if (body.roleId !== undefined && body.roleId !== current.roleId) {
    await updateVisitorUserRole(db, params.id, body.roleId)
  }
  if (body.profileFields !== undefined) {
    // Merge the patch onto existing values so a partial update (one field)
    // doesn't wipe the others. The handler is the only admin write path, so
    // this is the single merge point.
    const merged = { ...current.profileFields, ...body.profileFields }
    await updateVisitorUserProfileFields(db, params.id, merged)
  }
  if (body.status !== undefined && body.status !== current.status) {
    await setVisitorUserStatus(db, params.id, body.status)
    // Suspending a visitor invalidates their active sessions so they can't
    // keep browsing on a cookie issued before the suspension.
    if (body.status === 'suspended') {
      await revokeAllVisitorSessionsForUser(db, params.id)
    }
  }

  const updated = await findVisitorUserById(db, params.id)
  await createAuditEvent(db, {
    actorUserId: actor.id,
    action: 'visitor_auth.user_updated',
    targetType: 'user',
    targetId: params.id,
    metadata: { email: current.email, changes: JSON.stringify(body) },
    ...requestAuditContext(req),
  })

  return jsonResponse({ user: updated ? await toAdminVisitor(db, updated) : null })
}

async function handleDeleteUser(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor

  const current = await findVisitorUserById(db, params.id)
  if (!current) return jsonResponse({ error: 'visitor not found' }, { status: 404 })

  // Revoke sessions first, then soft-delete. Order matters: once deleted_at
  // is set the session-validation lookup (active + non-deleted) stops matching
  // anyway, but explicit revoke also clears the in-memory cache path.
  await revokeAllVisitorSessionsForUser(db, params.id)
  await softDeleteVisitorUser(db, params.id)

  await createAuditEvent(db, {
    actorUserId: actor.id,
    action: 'visitor_auth.user_deleted',
    targetType: 'user',
    targetId: params.id,
    metadata: { email: current.email },
    ...requestAuditContext(req),
  })

  return jsonResponse({ ok: true })
}

// ─── Route table + dispatcher ────────────────────────────────────────────────

const VISITOR_AUTH_ROUTES: readonly Route<[]>[] = [
  { method: 'GET',   pattern: `${PREFIX}/config`,                 handler: handleGetConfig },
  { method: 'PUT',   pattern: `${PREFIX}/config`,                 handler: handlePutConfig },
  { method: 'GET',   pattern: `${PREFIX}/roles`,                  handler: handleListRoles },
  { method: 'POST',  pattern: `${PREFIX}/roles`,                  handler: handleCreateRole },
  { method: 'PATCH', pattern: new RegExp(`^${PREFIX}/roles/(?<id>[^/]+)$`), handler: handleUpdateRole },
  { method: 'DELETE',pattern: new RegExp(`^${PREFIX}/roles/(?<id>[^/]+)$`), handler: handleDeleteRole },
  { method: 'GET',   pattern: `${PREFIX}/groups`,                 handler: handleListGroups },
  { method: 'POST',  pattern: `${PREFIX}/groups`,                 handler: handleCreateGroup },
  { method: 'PATCH', pattern: new RegExp(`^${PREFIX}/groups/(?<id>[^/]+)$`), handler: handleUpdateGroup },
  { method: 'DELETE',pattern: new RegExp(`^${PREFIX}/groups/(?<id>[^/]+)$`), handler: handleDeleteGroup },
  { method: 'GET',   pattern: new RegExp(`^${PREFIX}/groups/(?<id>[^/]+)/members$`), handler: handleListGroupMembers },
  { method: 'GET',   pattern: `${PREFIX}/users`,                  handler: handleListUsers },
  { method: 'PATCH', pattern: new RegExp(`^${PREFIX}/users/(?<id>[^/]+)$`), handler: handlePatchUser },
  { method: 'DELETE',pattern: new RegExp(`^${PREFIX}/users/(?<id>[^/]+)$`), handler: handleDeleteUser },
  { method: 'GET',   pattern: new RegExp(`^${PREFIX}/users/(?<id>[^/]+)/groups$`), handler: handleGetUserGroups },
  { method: 'PUT',   pattern: new RegExp(`^${PREFIX}/users/(?<id>[^/]+)/groups$`), handler: handlePutUserGroups },
]

export async function handleVisitorAuthAdminRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  if (!pathname.startsWith(`${PREFIX}/`)) return null
  return runRouteTable(req, db, VISITOR_AUTH_ROUTES)
}
