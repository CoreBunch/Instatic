/**
 * Visitor-auth admin persistence adapters.
 *
 * Mirrors `cmsUsers.ts`: thin `apiRequest` wrappers over the
 * `/admin/api/cms/visitor-auth/*` admin namespace (all gated by
 * `users.manage`). The visitor *facing* auth surface (`/api/visitor/*`)
 * is a separate namespace spoken to by the published-site runtime, not
 * the admin app — these adapters only cover admin config + visitor-user
 * management.
 *
 * Base path is intentionally NOT the `/admin/api/cms` used by `cmsUsers` —
 * these routes live under the `visitor-auth` sub-namespace.
 */
import { Type, type Static } from '@sinclair/typebox'
import { apiRequest, type FetchLike } from '@core/http'

// ─── Shapes (mirror server/handlers/cms/visitorAuth.ts exactly) ─────────────

const VisitorProfileFieldSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  type: Type.Union([
    Type.Literal('text'),
    Type.Literal('longText'),
    Type.Literal('select'),
    Type.Literal('boolean'),
  ]),
  required: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(Type.Object({
    value: Type.String(),
    label: Type.String(),
  }))),
})

/** A site-builder-defined visitor profile field (mirrors the server shape). */
export type VisitorProfileField = Static<typeof VisitorProfileFieldSchema>

const VisitorAuthConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  // D15: default landing path for a logged-in visitor with no primary-group
  // landing. Replaces the retired Phase-1/2 `protectedPrefixes` (page access
  // is now per-page, D14).
  defaultLandingPath: Type.String(),
  loginPath: Type.String(),
  registrationOpen: Type.Boolean(),
  defaultRole: Type.String(),
  // Per-visitor-data framework: site-builder-defined custom profile field
  // DEFINITIONS. Values live per-visitor in visitor_users.profile_fields_json.
  profileFields: Type.Array(VisitorProfileFieldSchema),
})

export type VisitorAuthConfig = Static<typeof VisitorAuthConfigSchema>

/**
 * Merge-patch payload for `PUT /config`. Every field is optional — the
 * server merge-patches only the supplied keys.
 */
export type VisitorAuthConfigPatch = Partial<VisitorAuthConfig>

const VisitorRoleSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  capabilities: Type.Array(Type.String()),
  isSystem: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type VisitorRole = Static<typeof VisitorRoleSchema>

/**
 * POST body for `/roles`. Capabilities are free-form strings (Phase-1 visitor
 * capabilities are not the closed `CoreCapability` enum).
 */
export type VisitorRoleCreateInput = {
  name: string
  capabilities: string[]
}

/**
 * PATCH body for `/roles/:id`. Either field may be omitted.
 */
export type VisitorRolePatchInput = {
  name?: string
  capabilities?: string[]
}

const VisitorUserStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('suspended'),
])

/**
 * The admin-facing visitor shape — never exposes `passwordHash`. Mirrors
 * `toAdminVisitor` in the server handler (id, email, displayName, roleId,
 * roleName, status, failedLoginCount, lockedUntil, createdAt).
 */
const AdminVisitorUserSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  roleId: Type.String(),
  roleName: Type.String(),
  status: VisitorUserStatusSchema,
  failedLoginCount: Type.Number(),
  lockedUntil: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  // Per-visitor-data framework: custom profile field VALUES.
  profileFields: Type.Record(Type.String(), Type.Unknown()),
})

export type AdminVisitorUser = Static<typeof AdminVisitorUserSchema>

/**
 * PATCH body for `/users/:id`. The server accepts status / roleId /
 * displayName / profileFields (any subset).
 */
export type VisitorUserPatch = {
  status?: Static<typeof VisitorUserStatusSchema>
  roleId?: string
  displayName?: string
  profileFields?: Record<string, unknown>
}

// ─── Groups + memberships (Phase 3 — D13/D14/D15) ───────────────────────────

/**
 * A visitor member-group — a content-segmentation segment used for page-level
 * access (D14) and login-redirect landing (D15), orthogonal to a role
 * (capabilities — D13). Mirrors `VisitorGroup` in the server `groups` module
 * exactly (id, name, slug, landingPath, description, isSystem, timestamps).
 */
const VisitorGroupSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  landingPath: Type.String(),
  description: Type.String(),
  isSystem: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type VisitorGroup = Static<typeof VisitorGroupSchema>

/**
 * POST body for `/groups`. `landingPath` defaults to `/` on the server when
 * omitted/blank; `description` defaults to `''`.
 */
export type VisitorGroupCreateInput = {
  name: string
  landingPath?: string
  description?: string
}

/**
 * PATCH body for `/groups/:id`. Any subset of name / landingPath / description.
 */
export type VisitorGroupPatchInput = {
  name?: string
  landingPath?: string
  description?: string
}

/**
 * One of a visitor's group memberships, flagging whether it is their
 * designated primary group (D15). Mirrors `VisitorMembershipView` in the
 * server `groups` module.
 */
const VisitorMembershipSchema = Type.Object({
  group: VisitorGroupSchema,
  isPrimary: Type.Boolean(),
})

export type VisitorMembership = Static<typeof VisitorMembershipSchema>

/**
 * A single membership row in the group-members list (`GET /groups/:id/members`).
 * Joins the junction to `visitor_users` for display; `isPrimary` is true when
 * the visitor's designated primary group is this group.
 */
const GroupMemberSchema = Type.Object({
  userId: Type.String(),
  groupId: Type.String(),
  isPrimary: Type.Boolean(),
  joinedAt: Type.String(),
})

export type VisitorGroupMember = Static<typeof GroupMemberSchema>

// ─── Envelopes ──────────────────────────────────────────────────────────────

const ConfigEnvelope = Type.Object(
  { config: Type.Optional(VisitorAuthConfigSchema) },
  { additionalProperties: true },
)
const RolesEnvelope = Type.Object(
  { roles: Type.Optional(Type.Array(VisitorRoleSchema)) },
  { additionalProperties: true },
)
const VisitorRoleEnvelope = Type.Object(
  { role: Type.Optional(VisitorRoleSchema) },
  { additionalProperties: true },
)
const VisitorUsersEnvelope = Type.Object(
  {
    users: Type.Optional(Type.Array(AdminVisitorUserSchema)),
    total: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)
const VisitorUserEnvelope = Type.Object(
  { user: Type.Optional(AdminVisitorUserSchema) },
  { additionalProperties: true },
)
const VisitorGroupsEnvelope = Type.Object(
  { groups: Type.Optional(Type.Array(VisitorGroupSchema)) },
  { additionalProperties: true },
)
const VisitorGroupEnvelope = Type.Object(
  { group: Type.Optional(VisitorGroupSchema) },
  { additionalProperties: true },
)
/** `{ userId, memberships }` returned by GET/PUT `/users/:id/groups`. */
const VisitorMembershipsEnvelope = Type.Object(
  { memberships: Type.Optional(Type.Array(VisitorMembershipSchema)) },
  { additionalProperties: true },
)
/** `{ group, members }` returned by `GET /groups/:id/members`. */
const GroupMembersEnvelope = Type.Object(
  {
    group: Type.Optional(VisitorGroupSchema),
    members: Type.Optional(Type.Array(GroupMemberSchema)),
  },
  { additionalProperties: true },
)

const DEFAULT_BASE_PATH = '/admin/api/cms/visitor-auth'

const defaultFetch: FetchLike = globalThis.fetch.bind(globalThis)

// ─── Config ─────────────────────────────────────────────────────────────────

export async function getVisitorAuthConfig(
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorAuthConfig> {
  const body = await apiRequest(`${basePath}/config`, {
    schema: ConfigEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor-auth config request failed',
  })
  if (!body.config) throw new Error('Visitor-auth config response was missing config')
  return body.config
}

export async function saveVisitorAuthConfig(
  patch: VisitorAuthConfigPatch,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorAuthConfig> {
  const body = await apiRequest(`${basePath}/config`, {
    method: 'PUT',
    body: patch,
    schema: ConfigEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor-auth config save failed',
  })
  if (!body.config) throw new Error('Visitor-auth config save response was missing config')
  return body.config
}

// ─── Roles ──────────────────────────────────────────────────────────────────

export async function listVisitorRoles(
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorRole[]> {
  const body = await apiRequest(`${basePath}/roles`, {
    schema: RolesEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor roles request failed',
  })
  return body.roles ?? []
}

/**
 * Create a custom visitor role (`POST /roles`). Throws an `ApiError` with
 * `status === 409` when the name is already in use (server-side enforced).
 */
export async function createVisitorRole(
  input: VisitorRoleCreateInput,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorRole> {
  const body = await apiRequest(`${basePath}/roles`, {
    method: 'POST',
    body: input,
    schema: VisitorRoleEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor role create failed',
  })
  if (!body.role) throw new Error('Visitor role create response was missing role')
  return body.role
}

/**
 * Update a visitor role (`PATCH /roles/:id`). Either field may be omitted.
 * Throws an `ApiError` with `status === 404` (unknown role) or `409` (name
 * in use). System roles are editable (capabilities/name) but never deletable.
 */
export async function updateVisitorRole(
  roleId: string,
  input: VisitorRolePatchInput,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorRole> {
  const body = await apiRequest(`${basePath}/roles/${encodeURIComponent(roleId)}`, {
    method: 'PATCH',
    body: input,
    schema: VisitorRoleEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor role update failed',
  })
  if (!body.role) throw new Error('Visitor role update response was missing role')
  return body.role
}

/**
 * Delete a visitor role (`DELETE /roles/:id`). Throws an `ApiError` with
 * `status === 404` (unknown role) or `409` (system role, or still assigned
 * to visitors). Resolves to `void` on success.
 */
export async function deleteVisitorRole(
  roleId: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<void> {
  await apiRequest(`${basePath}/roles/${encodeURIComponent(roleId)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'Visitor role delete failed',
  })
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface ListVisitorUsersOptions {
  search?: string
  limit?: number
  offset?: number
}

export async function listVisitorUsers(
  { search, limit, offset }: ListVisitorUsersOptions = {},
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<{ users: AdminVisitorUser[]; total: number }> {
  const body = await apiRequest(`${basePath}/users`, {
    schema: VisitorUsersEnvelope,
    query: { search, limit, offset },
    fetchImpl,
    fallbackMessage: 'Visitor users request failed',
  })
  return { users: body.users ?? [], total: body.total ?? 0 }
}

export async function updateVisitorUser(
  id: string,
  patch: VisitorUserPatch,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<AdminVisitorUser> {
  const body = await apiRequest(`${basePath}/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    schema: VisitorUserEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor user update failed',
  })
  if (!body.user) throw new Error('Visitor user update response was missing user')
  return body.user
}

export async function deleteVisitorUser(
  id: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<void> {
  await apiRequest(`${basePath}/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'Visitor user delete failed',
  })
}

// ─── Groups (Phase 3 — D13/D14/D15) ─────────────────────────────────────────

/**
 * List every visitor group (`GET /groups`), system groups first then by name.
 */
export async function listVisitorGroups(
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorGroup[]> {
  const body = await apiRequest(`${basePath}/groups`, {
    schema: VisitorGroupsEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor groups request failed',
  })
  return body.groups ?? []
}

/**
 * Create a visitor group (`POST /groups`). `landingPath` defaults to `/` on
 * the server when omitted. Throws an `ApiError` with `status === 409` when the
 * name is already in use (server-side enforced).
 */
export async function createVisitorGroup(
  input: VisitorGroupCreateInput,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorGroup> {
  const body = await apiRequest(`${basePath}/groups`, {
    method: 'POST',
    body: input,
    schema: VisitorGroupEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor group create failed',
  })
  if (!body.group) throw new Error('Visitor group create response was missing group')
  return body.group
}

/**
 * Update a visitor group (`PATCH /groups/:id`). Any subset of name /
 * landingPath / description. Throws an `ApiError` with `status === 404`
 * (unknown group) or `409` (name in use).
 */
export async function updateVisitorGroup(
  groupId: string,
  input: VisitorGroupPatchInput,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<VisitorGroup> {
  const body = await apiRequest(`${basePath}/groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH',
    body: input,
    schema: VisitorGroupEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor group update failed',
  })
  if (!body.group) throw new Error('Visitor group update response was missing group')
  return body.group
}

/**
 * Delete a visitor group (`DELETE /groups/:id`). The membership junction
 * CASCADEs, so deleting a group also removes every membership; a visitor whose
 * primary group is the deleted row keeps browsing and just falls back to the
 * default landing path on next login. Throws an `ApiError` with
 * `status === 404` (unknown group). Resolves to `void` on success.
 */
export async function deleteVisitorGroup(
  groupId: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<void> {
  await apiRequest(`${basePath}/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'Visitor group delete failed',
  })
}

/**
 * List a visitor's group memberships (`GET /users/:id/groups`). Returns the
 * groups the visitor belongs to plus whether one of them is their designated
 * primary group. The server envelope is `{ userId, memberships }`; this adapter
 * surfaces a clean `{ groups: VisitorMembership[] }` for consumers.
 */
export async function getVisitorGroups(
  userId: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<{ groups: VisitorMembership[] }> {
  const body = await apiRequest(`${basePath}/users/${encodeURIComponent(userId)}/groups`, {
    schema: VisitorMembershipsEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor group membership request failed',
  })
  return { groups: body.memberships ?? [] }
}

/**
 * Set a visitor's group memberships (`PUT /users/:id/groups`). Replaces the
 * existing set and optionally updates the primary group. `primaryGroupId: null`
 * clears the primary; omitting `primaryGroupId` leaves it untouched. Setting a
 * primary group the visitor is NOT (post-write) a member of is rejected by
 * the server (409). Returns the post-write membership set.
 */
export async function setVisitorGroups(
  userId: string,
  input: { groupIds: string[]; primaryGroupId?: string | null },
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<{ groups: VisitorMembership[] }> {
  const body = await apiRequest(`${basePath}/users/${encodeURIComponent(userId)}/groups`, {
    method: 'PUT',
    body: input,
    schema: VisitorMembershipsEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor group membership save failed',
  })
  return { groups: body.memberships ?? [] }
}

/**
 * List the members of a group (`GET /groups/:id/members`). Joins the junction
 * to `visitor_users` for display, flagging each row whose primary group is
 * this group. Returns the group row plus its member list.
 */
export async function listGroupMembers(
  groupId: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = DEFAULT_BASE_PATH,
): Promise<{ group: VisitorGroup; members: VisitorGroupMember[] }> {
  const body = await apiRequest(`${basePath}/groups/${encodeURIComponent(groupId)}/members`, {
    schema: GroupMembersEnvelope,
    fetchImpl,
    fallbackMessage: 'Visitor group members request failed',
  })
  if (!body.group) throw new Error('Visitor group members response was missing group')
  return { group: body.group, members: body.members ?? [] }
}
