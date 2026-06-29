/**
 * Audit-event labelling helpers.
 *
 * The CMS persists audit events with raw IDs (`actorUserId`, `targetId`) and
 * a small `metadata` bag. The Users → Audit tab needs to enrich these with
 * the *current* display name of the related user/role, falling back to the
 * snapshot label captured at write time when the related row no longer
 * exists. These helpers do that enrichment, plus the per-action
 * sentence-case title rendering.
 */
import type { CmsAuditEvent, CmsCurrentUser, CmsRole } from '@core/persistence'
import { displayUserName, statusLabel } from './format'

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value
}

function humanizeActionId(action: string): string {
  const words = action.split('.').filter(Boolean)
  if (words.length === 0) return 'Unknown activity'
  return capitalize(words.join(' '))
}

function dataTableLabel(event: CmsAuditEvent): string {
  return metadataString(event.metadata, 'name')
    ?? metadataString(event.metadata, 'slug')
    ?? event.targetId
    ?? 'unknown table'
}

function dataRowLabel(event: CmsAuditEvent): string {
  return metadataString(event.metadata, 'slug') ?? event.targetId ?? 'unknown row'
}

function aiCredentialLabel(event: CmsAuditEvent): string {
  return metadataString(event.metadata, 'displayLabel') ?? event.targetId ?? 'AI credential'
}

function aiScopeLabel(event: CmsAuditEvent): string {
  return metadataString(event.metadata, 'scope') ?? event.targetId ?? 'scope'
}

function auditUserLabel(
  userId: string | null,
  usersById: Map<string, CmsCurrentUser>,
  fallback: string | null,
): string | null {
  if (!userId) return fallback
  const user = usersById.get(userId)
  return user ? displayUserName(user) : fallback ?? userId
}

export function auditActor(event: CmsAuditEvent, usersById: Map<string, CmsCurrentUser>): string {
  if (!event.actorUserId) return 'by system'
  return `by ${auditUserLabel(event.actorUserId, usersById, event.actorLabel)}`
}

function auditTargetUser(event: CmsAuditEvent, usersById: Map<string, CmsCurrentUser>): string {
  return auditUserLabel(event.targetId, usersById, event.targetLabel) ?? 'Unknown user'
}

function roleName(
  roleId: string | null,
  rolesById: Map<string, CmsRole>,
  fallback: string | null = null,
): string | null {
  if (!roleId) return null
  return rolesById.get(roleId)?.name ?? fallback ?? roleId
}

function auditTargetRole(event: CmsAuditEvent, rolesById: Map<string, CmsRole>): string | null {
  if (event.targetType !== 'role') return null
  return roleName(
    event.targetId,
    rolesById,
    event.targetLabel ?? metadataString(event.metadata, 'name') ?? metadataString(event.metadata, 'slug'),
  )
}

export function auditTitle(
  event: CmsAuditEvent,
  usersById: Map<string, CmsCurrentUser>,
  rolesById: Map<string, CmsRole>,
): string {
  const targetUser = auditTargetUser(event, usersById)
  const role = auditTargetRole(event, rolesById)
  const email = metadataString(event.metadata, 'email')
  const pluginId = metadataString(event.metadata, 'pluginId') ?? event.targetId ?? 'Plugin'
  const dataTable = dataTableLabel(event)
  const dataRow = dataRowLabel(event)
  const aiCredential = aiCredentialLabel(event)
  const aiScope = aiScopeLabel(event)

  switch (event.action) {
    case 'login.success':
      return `${event.actorUserId ? auditUserLabel(event.actorUserId, usersById, event.actorLabel) : email ?? 'User'} logged in`
    case 'login.failure':
      return `Failed login for ${email ?? targetUser}`
    case 'login.locked':
      return `${targetUser} was locked`
    case 'login.unlocked':
      return `${targetUser} was unlocked`
    case 'login.rate_limited':
      return email ? `Login rate limit hit for ${email}` : 'Login rate limit hit'
    case 'logout':
      return `${event.actorUserId ? auditUserLabel(event.actorUserId, usersById, event.actorLabel) : 'User'} logged out`
    case 'user.create':
      return `${targetUser} was created`
    case 'user.update':
      return `${targetUser} was updated`
    case 'user.delete':
      return `${targetUser} was deleted`
    case 'user.suspend':
      return `${targetUser} was suspended`
    case 'password.change':
      return `Password changed for ${targetUser}`
    case 'role.create':
      return `${role ?? 'Role'} was created`
    case 'role.update':
      return `${role ?? 'Role'} was updated`
    case 'role.delete':
      return `${role ?? event.targetId ?? 'Role'} was deleted`
    case 'role.assign':
      return `${targetUser} role changed`
    case 'data.table.create':
      return `Data table ${dataTable} was created`
    case 'data.table.update':
      return `Data table ${dataTable} was updated`
    case 'data.table.delete':
      return `Data table ${dataTable} was deleted`
    case 'data.row.create':
      return `Data row ${dataRow} was created`
    case 'data.row.update':
      return `Data row ${dataRow} was updated`
    case 'data.row.delete':
      return `Data row ${dataRow} was deleted`
    case 'data.row.publish':
      return `Data row ${dataRow} was published`
    case 'data.row.schedule':
      return `Data row ${dataRow} was scheduled`
    case 'data.row.schedule.cancel':
      return `Data row ${dataRow} schedule was canceled`
    case 'data.row.status':
      return `Data row ${dataRow} status changed`
    case 'data.row.move':
      return `Data row ${dataRow} was moved`
    case 'data.author.assign':
      return `Data row ${dataRow} author changed`
    case 'publish':
      return 'Site was published'
    case 'plugin.install':
      return `${pluginId} was installed`
    case 'plugin.update':
      return `${pluginId} was updated`
    case 'plugin.enable':
      return `${pluginId} was enabled`
    case 'plugin.disable':
      return `${pluginId} was disabled`
    case 'plugin.delete':
      return `${pluginId} was deleted`
    case 'plugin.pack.install':
      return `${pluginId} pack was installed`
    case 'plugin.settings.update':
      return `${pluginId} settings were updated`
    case 'ai.credential.created':
      return `AI credential ${aiCredential} was created`
    case 'ai.credential.updated':
      return `AI credential ${aiCredential} was updated`
    case 'ai.credential.deleted':
      return `AI credential ${aiCredential} was deleted`
    case 'ai.credential.tested':
      return `AI credential ${aiCredential} was tested`
    case 'ai.default.updated':
      return `AI default for ${aiScope} was updated`
    case 'ai.default.cleared':
      return `AI default for ${aiScope} was cleared`
    case 'ai.chat.started':
      return `AI chat in ${aiScope} started`
    case 'ai.chat.completed':
      return `AI chat in ${aiScope} completed`
    case 'ai.chat.failed':
      return `AI chat in ${aiScope} failed`
    case 'ai.mcp_connector.created':
      return `MCP connector was created`
    case 'ai.mcp_connector.revoked':
      return `MCP connector was revoked`
    default:
      return humanizeActionId(event.action)
  }
}

export function auditDetails(event: CmsAuditEvent, rolesById: Map<string, CmsRole>): string[] {
  const details: string[] = []
  const roleId = metadataString(event.metadata, 'roleId')
  const status = metadataString(event.metadata, 'status')
  if (roleId) details.push(`Role: ${roleName(roleId, rolesById, event.metadataLabels.roleId)}`)
  if (status) details.push(`Status: ${statusLabel(status as CmsCurrentUser['status'])}`)
  if (event.ipAddress && event.ipAddress !== 'unknown') details.push(`IP: ${event.ipAddress}`)
  return details
}
