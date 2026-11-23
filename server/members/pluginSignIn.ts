import { configuredPublicOrigin } from '../auth/security'
import type { DbClient } from '../db/client'
import { queueTemplateMail } from '../mail/delivery'
import { ensurePluginInstallId } from '../repositories/plugins'
import { memberTokenLink } from './mail'
import { MEMBER_MAIL_KEYS } from './mailTemplates'
import { getMemberPagePaths } from './pages'
import { findMemberById } from './repository'
import { prepareMemberToken } from './tokens'

/** A plugin can trigger the core template but cannot read, render or redirect the token. */
export async function queuePluginMemberSignIn(db: DbClient, pluginId: string, sourceLabel: string, memberId: string, reference: string): Promise<void> {
  const member = await findMemberById(db, memberId)
  if (!member || member.status !== 'active') throw new Error('That member cannot be emailed')
  const origin = configuredPublicOrigin()
  const issued = await prepareMemberToken(memberId, 'magic', { email: member.email })
  const link = origin && memberTokenLink(origin, await getMemberPagePaths(db), 'magic', issued.token)
  if (!link) throw new Error('Configure the public site address and publish a member sign-in link page.')
  await queueTemplateMail(db, {
    key: MEMBER_MAIL_KEYS.magic,
    to: member.email,
    variables: { 'member.email': member.email, link },
    source: pluginId, sourceLabel, memberId, reference,
    installId: (await ensurePluginInstallId(db, pluginId)) ?? undefined,
    deliverBefore: Date.parse(issued.expiresAt),
    async acceptOnce(tx) {
      const claim = await tx`
        insert into plugin_member_sign_in_requests (plugin_id, member_id, reference)
        values (${pluginId}, ${memberId}, ${reference})
        on conflict (plugin_id, member_id, reference) do nothing returning member_id
      `
      if (!claim.rows.length) return false
      await issued.store(tx)
      return true
    },
  })
}
