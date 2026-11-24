import type { CmsAuditEvent, CmsCurrentUser, CmsRole } from '@core/persistence'
import { statusLabel } from './format'

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

export function auditActor(event: CmsAuditEvent): string {
  return event.actorUserId ? `by ${event.actorLabel ?? event.actorUserId}` : 'by system'
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
  rolesById: Map<string, CmsRole>,
): string {
  const targetUser = event.targetLabel ?? event.targetId ?? 'Unknown user'
  const role = auditTargetRole(event, rolesById)
  const email = metadataString(event.metadata, 'email')
  const member = email ?? 'unknown'
  const pluginId = metadataString(event.metadata, 'pluginId') ?? event.targetId ?? 'Plugin'
  const dataTable = dataTableLabel(event)
  const dataRow = dataRowLabel(event)
  const aiCredential = aiCredentialLabel(event)
  const aiScope = aiScopeLabel(event)

  switch (event.action) {
    case 'login.success':
      return `${event.actorUserId ? (event.actorLabel ?? event.actorUserId) : email ?? 'User'} logged in`
    case 'login.failure':
      return `Failed login for ${email ?? targetUser}`
    case 'login.locked':
      return `${targetUser} was locked`
    case 'login.unlocked':
      return `${targetUser} was unlocked`
    case 'login.rate_limited':
      return email ? `Login rate limit hit for ${email}` : 'Login rate limit hit'
    case 'logout':
      return `${event.actorUserId ? (event.actorLabel ?? event.actorUserId) : 'User'} logged out`
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
    case 'data.table.access':
      return `Who can open the entries of data table ${dataTable} was changed`
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
    case 'mail.connector.create':
      return `Email connector ${metadataString(event.metadata, 'label') ?? ''} was added`.replace('  ', ' ')
    case 'mail.connector.delete':
      return `Email connector ${metadataString(event.metadata, 'label') ?? ''} was removed`.replace('  ', ' ')
    case 'mail.connector.secret':
      return `The secret of email connector ${metadataString(event.metadata, 'label') ?? ''} was replaced`.replace('  ', ' ')
    case 'mail.defaults.update':
      return 'Email defaults were updated'
    case 'mail.template.update':
      return `Email template ${event.targetId ?? ''} was edited`
    case 'mail.template.reset':
      return `Email template ${event.targetId ?? ''} was reset`
    case 'member.invite':
      return `Member ${member} was invited`
    case 'member.create':
      return `Member ${member} was given an account by ${pluginId}`
    case 'member.suspend':
      return `Member ${member} was suspended`
    case 'member.unsuspend':
      return `Member ${member} was restored`
    case 'member.export':
      return `Member ${member}'s data was downloaded`
    case 'member.signout':
      return `Member ${member} was signed out everywhere`
    case 'member.delete':
      return `Member ${member} was deleted`
    case 'member.tag.grant':
      return `Member ${member} was given the tag ${metadataString(event.metadata, 'tag') ?? ''}`
    case 'member.tag.revoke':
      return `Member ${member} lost the tag ${metadataString(event.metadata, 'tag') ?? ''}`
    case 'member.settings.update':
      return 'Member settings were changed'
    case 'member.app.create':
      return `App ${metadataString(event.metadata, 'name') ?? 'unknown'} was allowed to sign members in`
    case 'member.app.delete':
      return `App ${metadataString(event.metadata, 'name') ?? 'unknown'} was removed from member sign-in`
    case 'member.app.disconnect':
      return `Member ${member} was signed out of the app ${metadataString(event.metadata, 'app') ?? 'unknown'}`
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
    case 'service_account.created':
      return 'CLI connection created'
    case 'service_account.authorized':
      return 'CLI connection authorized'
    case 'service_account.renewed':
      return 'CLI connection renewed'
    case 'service_account.revoked':
      return 'CLI connection revoked'
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
