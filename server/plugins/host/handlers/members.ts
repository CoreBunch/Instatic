/**
 * Site member handlers — implement the `cms.members.*` api-calls.
 *
 * A plugin reads members with `members.read`, invites and creates them with
 * `members.write` and changes tags with `members.tags` (enforced centrally in
 * apiDispatch.ts via TARGET_PERMISSIONS; `ensure` also needs `members.read`,
 * since it answers with the member). All member SQL stays in `server/members`.
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
import { ensureMember, inviteMember } from '../../../members/admin'
import { memberEmailBlockers } from '../../../members/mail'
import { createAuditEvent } from '../../../repositories/audit'
import {
  findMemberByEmail,
  findMemberById,
  grantMemberTag,
  listDeletedMembersSince,
  revokeMemberTag,
  toCurrentMember,
  type MemberRecord,
} from '../../../members/repository'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import { assertHostPluginPermission } from '../registry'
import type { HostPluginRecord } from '../types'

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

/** The member as a plugin sees it: nothing secret, nothing about sessions. */
async function pluginMemberRecord(db: DbClient, member: MemberRecord) {
  const current = await toCurrentMember(db, member)
  return {
    id: current.id,
    email: current.email,
    emailVerified: current.emailVerified,
    status: member.status,
    tags: current.tags,
    profile: current.profile,
    createdAt: current.createdAt,
  }
}

export async function handleMembersGet(
  msg: ApiCallFor<'cms.members.get'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [by] = msg.args
  const member = 'id' in by ? await findMemberById(db, by.id) : await findMemberByEmail(db, by.email)
  replyApiOk(msg.pluginId, msg.correlationId, member ? await pluginMemberRecord(db, member) : null)
}

function assertGrantableTags(entry: HostPluginRecord, tags: readonly string[]): void {
  if (tags.length === 0) return
  // Tags given with a new member are tag grants like any other.
  assertHostPluginPermission(entry, 'members.tags')
  if (!tags.every(isGrantableMemberTag)) throw new Error('A tag in the request cannot be given to a member')
}

/**
 * The member with this address, created without a password and without any
 * email when there is none. Concurrent calls for one address get the same
 * member; exactly one of them reports `created`.
 */
export async function handleMembersEnsure(
  msg: ApiCallFor<'cms.members.ensure'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  // The answer is the member's record, which is reading members.
  assertHostPluginPermission(entry, 'members.read')
  const [{ email, tags = [] }] = msg.args
  if (!ADDRESS_RE.test(email.trim())) throw new Error('That is not a valid email address')
  assertGrantableTags(entry, tags)
  const { member, created } = await ensureMember(db, { email, tags, source: msg.pluginId })
  if (created) {
    await createAuditEvent(db, {
      actorUserId: null,
      action: 'member.create',
      targetType: 'member',
      targetId: member.id,
      metadata: { email: member.email, pluginId: msg.pluginId },
    })
  }
  replyApiOk(msg.pluginId, msg.correlationId, {
    member: await pluginMemberRecord(db, member),
    created,
    // An unconfirmed member may be someone else's unfinished sign-up with
    // this address: their profile is whatever was typed into the form.
    confirmed: member.emailVerifiedAt !== null,
  })
}

/** Remember the plugin's member export provider; the host calls it per export (`memberExport.ts`). */
export async function handleMembersExportProvider(
  msg: ApiCallFor<'cms.members.exportProvider'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  // Declared, so the export can name the plugin while it is not running.
  if (!entry.manifest.memberDataExport) {
    throw new Error('Declare "memberDataExport": true in plugin.json to offer a member export provider')
  }
  if (entry.memberExportFilterId !== null) throw new Error('This plugin already registered its member export provider')
  entry.memberExportFilterId = msg.args[0].filterId
  replyApiOk(msg.pluginId, msg.correlationId)
}

const DELETED_PAGE_SIZE = 100
const CURSOR_SEPARATOR = '|'

/**
 * Members deleted since the plugin's cursor, so a plugin that was not
 * running when `member.deleted` went out can still erase what it keeps. The
 * cursor is opaque to the plugin: the (deleted_at, id) of the last id handed
 * over.
 */
export async function handleMembersDeletedSince(
  msg: ApiCallFor<'cms.members.deletedSince'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [cursor, options] = msg.args
  let after: { deletedAt: string; id: string } | null = null
  if (cursor !== null) {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const at = decoded.indexOf(CURSOR_SEPARATOR)
    const deletedAt = decoded.slice(0, at)
    const id = decoded.slice(at + 1)
    if (at < 1 || !id || Number.isNaN(Date.parse(deletedAt))) {
      throw new Error('That is not a cursor from api.cms.members.deletedSince')
    }
    after = { deletedAt, id }
  }
  const page = await listDeletedMembersSince(db, after, options.limit ?? DELETED_PAGE_SIZE)
  const last = page.at(-1)
  const nextCursor = last
    ? Buffer.from(`${last.deletedAt}${CURSOR_SEPARATOR}${last.id}`, 'utf8').toString('base64url')
    : cursor
  replyApiOk(msg.pluginId, msg.correlationId, { ids: page.map((row) => row.id), nextCursor })
}

/** Whether the site can email members links it starts itself, and if not, why. */
export async function handleMembersEmailStatus(
  msg: ApiCallFor<'cms.members.emailStatus'>,
  _entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const reasons = await memberEmailBlockers(db)
  replyApiOk(msg.pluginId, msg.correlationId, { canEmail: reasons.length === 0, reasons })
}

export async function handleMembersInvite(
  msg: ApiCallFor<'cms.members.invite'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ email, tags = [] }] = msg.args
  if (!ADDRESS_RE.test(email.trim())) throw new Error('That is not a valid email address')
  assertGrantableTags(entry, tags)
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
