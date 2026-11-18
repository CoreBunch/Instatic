/**
 * Site member handlers — implement the `cms.members.*` api-calls.
 *
 * A plugin reads members with `members.read`, invites with `members.write`
 * and changes tags with `members.tags` (enforced centrally in apiDispatch.ts
 * via TARGET_PERMISSIONS). All member SQL stays in `server/members`.
 *
 * Tags a plugin grants carry the plugin's id as their source, and a plugin
 * can only withdraw its own: a shop cannot take away a tag an administrator
 * or another plugin gave.
 */
import type { DbClient } from '../../../db/client'
import { isGrantableMemberTag } from '@core/members'
import { MAIL_ADDRESS_PATTERN } from '@core/mail'
import { configuredPublicOrigin } from '../../../auth/security'
import { getMailDefaults } from '../../../mail/defaults'
import { mailDeliveryMode } from '../../../mail/send'
import { inviteMember } from '../../../members/admin'
import {
  findMemberByEmail,
  findMemberById,
  grantMemberTag,
  revokeMemberTag,
  toCurrentMember,
} from '../../../members/repository'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import { assertHostPluginPermission } from '../registry'
import type { HostPluginRecord } from '../types'

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

export async function handleMembersGet(
  msg: ApiCallFor<'cms.members.get'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [by] = msg.args
  const member = 'id' in by ? await findMemberById(db, by.id) : await findMemberByEmail(db, by.email)
  if (!member) {
    replyApiOk(msg.pluginId, msg.correlationId, null)
    return
  }
  const current = await toCurrentMember(db, member)
  replyApiOk(msg.pluginId, msg.correlationId, {
    id: current.id,
    email: current.email,
    emailVerified: current.emailVerified,
    status: member.status,
    tags: current.tags,
    profile: current.profile,
    createdAt: current.createdAt,
  })
}

export async function handleMembersInvite(
  msg: ApiCallFor<'cms.members.invite'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ email, tags = [] }] = msg.args
  if (!ADDRESS_RE.test(email.trim())) throw new Error('That is not a valid email address')
  if (tags.length > 0) {
    // Tags on an invitation are tag grants like any other.
    assertHostPluginPermission(entry, 'members.tags')
    if (!tags.every(isGrantableMemberTag)) throw new Error('A tag in the invitation cannot be given to a member')
  }
  // An invitation is a link in an email. With no request to take an address
  // from, the link can only use the site's configured public address.
  const linkOrigin = configuredPublicOrigin()
  if (!linkOrigin) throw new Error('The site has no public address configured, so an invitation cannot be emailed')
  if (mailDeliveryMode(await getMailDefaults(db)) === 'off') {
    throw new Error('Outgoing email is not set up, so an invitation cannot be emailed')
  }
  const result = await inviteMember(db, { email, tags, linkOrigin, tagSource: msg.pluginId })
  if (!result.ok) {
    throw new Error(
      result.reason === 'no_page'
        ? 'The site has no invitation page yet; its owner sets one in the member settings'
        : 'That address already has an account',
    )
  }
  replyApiOk(msg.pluginId, msg.correlationId, { memberId: result.member.id, outcome: result.outcome })
}

export async function handleMembersTagsGrant(
  msg: ApiCallFor<'cms.members.tags.grant'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [memberId, tag, options] = msg.args
  if (!isGrantableMemberTag(tag)) throw new Error(`"${tag}" is not a tag a member can be given`)
  let expiresAt: string | null = null
  if (options.expiresAt) {
    const at = Date.parse(options.expiresAt)
    if (Number.isNaN(at) || at <= Date.now()) throw new Error('The end of a tag must be a date in the future')
    expiresAt = new Date(at).toISOString()
  }
  if (!(await findMemberById(db, memberId))) throw new Error('Member not found')
  await grantMemberTag(db, { memberId, tag, source: msg.pluginId, expiresAt })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleMembersTagsRevoke(
  msg: ApiCallFor<'cms.members.tags.revoke'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [memberId, tag] = msg.args
  // Only this plugin's own grant: the source is the host-verified plugin id.
  await revokeMemberTag(db, { memberId, tag, source: msg.pluginId })
  replyApiOk(msg.pluginId, msg.correlationId)
}
