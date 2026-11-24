import { Type } from '@core/utils/typeboxHelpers'
import { MailConnectorInputSchema, MailConnectorSecretInputSchema, MailDefaultsSchema, MailTemplateInputSchema, MailTemplateSendingSchema, MailTestInputSchema } from '@core/mail'
import { CreateMemberAppBodySchema, MemberInviteInputSchema, MemberSettingsSchema, MemberTagInputSchema, MemberTagRemoveInputSchema } from '@core/members'
import { UserCreateBodySchema, UserPatchBodySchema } from '../../handlers/cms/users'
import { DASHBOARD_READERS } from '../../handlers/cms/dashboard'
import { operation as op } from './operation'

const members = ['members.read', 'members.manage'] as const
const manage = 'members.manage'
const mail = 'mail.manage'
const users = 'users.manage'
export const adminOperations = [
  ...Object.entries(DASHBOARD_READERS).map(([name, endpoint]) =>
    op('GET', 'dashboard/' + name, [['dashboard.read'], [endpoint.capability]], 'Read dashboard ' + name + ' statistics', {
      querySchema: Type.Object({ tz: Type.Optional(Type.String({ description: 'IANA time zone' })) }),
    })),
  op('GET', 'users', users, 'List CMS users', { querySchema: Type.Partial(Type.Object({ q: Type.String(), offset: Type.Integer() })) }),
  op('POST', 'users', users, 'Create a user with a role you can assign', { bodySchema: UserCreateBodySchema }),
  op('PATCH', 'users/:id', users, 'Update user profile, password, role or status within your grant', { bodySchema: UserPatchBodySchema }),
  op('DELETE', 'users/:id', users, 'Soft-delete a user'),
  op('GET', 'roles', ['roles.manage', users], 'List roles and their grants'),
  op('GET', 'audit', 'audit.read', 'List recent CMS audit events'),
  op('GET', 'members', members, 'List site members', { querySchema: Type.Partial(Type.Object({ q: Type.String(), offset: Type.Integer(), tag: Type.String(), status: Type.String() })) }),
  op('GET', 'members/:id', members, 'Read member profile, tags, activity and sessions'),
  op('POST', 'members/invite', manage, 'Invite a site member', { bodySchema: MemberInviteInputSchema }),
  op('DELETE', 'members/:id', manage, 'Delete a site member'),
  op('POST', 'members/:id/suspend', manage, 'Suspend a site member'),
  op('POST', 'members/:id/unsuspend', manage, 'Restore sign-in for a suspended site member'),
  op('POST', 'members/:id/sign-out', manage, 'End all sessions for a site member'),
  op('GET', 'members/:id/export', manage, 'Export the member’s data including plugin sections', { outputFile: 'member.json' }),
  op('POST', 'members/:id/tags', manage, 'Grant a member tag', { bodySchema: MemberTagInputSchema }),
  op('DELETE', 'members/:id/tags', manage, 'Revoke a member tag', { bodySchema: MemberTagRemoveInputSchema }),
  op('GET', 'members/settings', members, 'Read member settings. For the setup workflow use instatic api lookup membership.'),
  op('PUT', 'members/settings', manage, 'Save member settings', { bodySchema: MemberSettingsSchema }),
  op('GET', 'members/apps', members, 'List member apps'),
  op('POST', 'members/apps', manage, 'Create a member app', { bodySchema: CreateMemberAppBodySchema }),
  op('DELETE', 'members/apps/:id', manage, 'Remove a member app'),
  op('DELETE', 'members/:id/apps/:grantId', manage, 'Disconnect a member app grant'),
  op('GET', 'mail', mail, 'Inspect mail settings and configured connectors'),
  op('POST', 'mail/connectors', mail, 'Create an outgoing email connector', { bodySchema: MailConnectorInputSchema }),
  op('DELETE', 'mail/connectors/:id', mail, 'Remove an outgoing email connector'),
  op('PUT', 'mail/connectors/:id/secret', mail, 'Replace the secret of an email connector', { bodySchema: MailConnectorSecretInputSchema }),
  op('POST', 'mail/connectors/:id/test', mail, 'Send a test email through this connector', { bodySchema: MailTestInputSchema }),
  op('PUT', 'mail/defaults', mail, 'Set the default email connector and sender', { bodySchema: MailDefaultsSchema }),
  op('GET', 'mail/templates', mail, 'List effective email templates'),
  op('PUT', 'mail/templates/:key', mail, 'Save an email template', { bodySchema: MailTemplateInputSchema }),
  op('PUT', 'mail/templates/:key/sending', mail, 'Turn sending on or off for an email template', { bodySchema: MailTemplateSendingSchema }),
  op('DELETE', 'mail/templates/:key', mail, 'Reset an email template'),
  op('POST', 'mail/templates/:key/test', mail, 'Send a test of an email template', { bodySchema: MailTestInputSchema }),
  op('GET', 'mail/activity', mail, 'Inspect delivery events', { querySchema: Type.Partial(Type.Object({
    period: Type.String({ description: '24h, 7d, 30d or all' }), tz: Type.String(), status: Type.String({ description: 'sent, failed or captured' }),
    kind: Type.String(), connector: Type.String(), q: Type.String(), before: Type.String(),
  })) }),
]
