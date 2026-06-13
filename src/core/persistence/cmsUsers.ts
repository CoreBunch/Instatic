import { Type, type Static } from '@sinclair/typebox'
import { apiRequest, type FetchLike } from '@core/http'
import { CmsCurrentUserSchema, type CmsCurrentUser } from './cmsAuth'

const CmsRoleSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.String(),
  isSystem: Type.Boolean(),
  capabilities: Type.Array(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type CmsRole = Static<typeof CmsRoleSchema>

const CmsAuditEventSchema = Type.Object({
  id: Type.String(),
  actorUserId: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  targetType: Type.Union([Type.String(), Type.Null()]),
  targetId: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  actorLabel: Type.Union([Type.String(), Type.Null()]),
  targetLabel: Type.Union([Type.String(), Type.Null()]),
  metadataLabels: Type.Record(Type.String(), Type.String()),
  ipAddress: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

export type CmsAuditEvent = Static<typeof CmsAuditEventSchema>

const UsersEnvelope = Type.Object({ users: Type.Optional(Type.Array(CmsCurrentUserSchema)) }, { additionalProperties: true })
const UserEnvelope = Type.Object({ user: Type.Optional(CmsCurrentUserSchema) }, { additionalProperties: true })
const RolesEnvelope = Type.Object({ roles: Type.Optional(Type.Array(CmsRoleSchema)) }, { additionalProperties: true })
const RoleEnvelope = Type.Object({ role: Type.Optional(CmsRoleSchema) }, { additionalProperties: true })
const AuditEnvelope = Type.Object({ events: Type.Optional(Type.Array(CmsAuditEventSchema)) }, { additionalProperties: true })

export async function listCmsUsers(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser[]> {
  const body = await apiRequest(`${basePath}/users`, {
    schema: UsersEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS users request failed',
  })
  return body.users ?? []
}

export async function createCmsUser(
  input: { email: string; displayName: string; password: string; roleId: string; status?: 'active' | 'suspended' },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const body = await apiRequest(`${basePath}/users`, {
    method: 'POST',
    body: input,
    schema: UserEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS user create failed',
  })
  if (!body.user) throw new Error('CMS user create response was missing user')
  return body.user
}

export async function updateCmsUser(
  userId: string,
  input: Partial<{ email: string; displayName: string; password: string; roleId: string; status: 'active' | 'suspended' }>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const body = await apiRequest(`${basePath}/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: input,
    schema: UserEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS user update failed',
  })
  if (!body.user) throw new Error('CMS user update response was missing user')
  return body.user
}

export async function deleteCmsUser(
  userId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  await apiRequest(`${basePath}/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'CMS user delete failed',
  })
}

export async function listCmsRoles(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRole[]> {
  const body = await apiRequest(`${basePath}/roles`, {
    schema: RolesEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS roles request failed',
  })
  return body.roles ?? []
}

export async function createCmsRole(
  input: { name: string; slug?: string; description: string; capabilities: string[] },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRole> {
  const body = await apiRequest(`${basePath}/roles`, {
    method: 'POST',
    body: input,
    schema: RoleEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS role create failed',
  })
  if (!body.role) throw new Error('CMS role create response was missing role')
  return body.role
}

export async function updateCmsRole(
  roleId: string,
  input: Partial<{ name: string; slug: string; description: string; capabilities: string[] }>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRole> {
  const body = await apiRequest(`${basePath}/roles/${encodeURIComponent(roleId)}`, {
    method: 'PATCH',
    body: input,
    schema: RoleEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS role update failed',
  })
  if (!body.role) throw new Error('CMS role update response was missing role')
  return body.role
}

export async function deleteCmsRole(
  roleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  await apiRequest(`${basePath}/roles/${encodeURIComponent(roleId)}`, {
    method: 'DELETE',
    fetchImpl,
    fallbackMessage: 'CMS role delete failed',
  })
}

export async function listCmsAuditEvents(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsAuditEvent[]> {
  const body = await apiRequest(`${basePath}/audit`, {
    schema: AuditEnvelope,
    fetchImpl,
    fallbackMessage: 'CMS audit events request failed',
  })
  return body.events ?? []
}
