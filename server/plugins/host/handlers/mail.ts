/**
 * Email handlers — implement the `cms.mail.*` api-calls and
 * `cms.site.publicUrl`.
 *
 * A plugin sends only the templates its manifest declares, with values for
 * the variables each declares. `cms.mail.send` (permission `mail.send`)
 * reaches a site member, whose address the host looks up;
 * `cms.mail.sendExternal` (permission `mail.send.external`) reaches any
 * address. Both permissions are enforced centrally in apiDispatch.ts via
 * TARGET_PERMISSIONS. Every email goes through the site's mail queue, under
 * the plugin's id, so the limits and the activity log are per plugin.
 */
import type { DbClient } from '../../../db/client'
import { hookBus } from '@core/plugins/hookBus'
import { pluginMailTemplateKey, pluginMailTemplatePrefix } from '@core/plugins/manifestMail'
import { configuredPublicOrigin } from '../../../auth/security'
import { queueTemplateMail, type QueuedMailOutcome } from '../../../mail/delivery'
import { findMemberById } from '../../../members/repository'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

interface PluginMail {
  template: string
  to: string
  variables: Record<string, string>
  reference?: string
  /** Set when the plugin named a member and the host looked the address up. */
  memberId?: string
}

async function queuePluginMail(db: DbClient, entry: HostPluginRecord, mail: PluginMail): Promise<'queued' | 'captured'> {
  const template = entry.manifest.mail?.templates.find((candidate) => candidate.key === mail.template)
  if (!template) throw new Error(`"${mail.template}" is not an email template this plugin declares`)
  const declared = new Set(template.variables.map((variable) => variable.name))
  const unknown = Object.keys(mail.variables).filter((name) => !declared.has(name))
  if (unknown.length > 0) {
    throw new Error(`The "${mail.template}" template has no variable named ${unknown.map((name) => `"${name}"`).join(', ')}`)
  }
  return queueTemplateMail(db, {
    key: pluginMailTemplateKey(entry.manifest.id, mail.template),
    to: mail.to,
    variables: mail.variables,
    source: entry.manifest.id,
    reference: mail.reference,
    memberId: mail.memberId,
  })
}

export async function handleMailSend(
  msg: ApiCallFor<'cms.mail.send'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ template, member: memberId, variables, reference }] = msg.args
  // `findMemberById` leaves deleted members out; a suspended one is not written to either.
  const member = await findMemberById(db, memberId)
  if (!member || member.status !== 'active') throw new Error('That member cannot be emailed')
  // The address is the host's to know. Nothing sent back to the plugin, now
  // or with the outcome, carries it: `mail.send` is not a way to read members.
  const status = await queuePluginMail(db, entry, { template, to: member.email, variables, reference, memberId })
  replyApiOk(msg.pluginId, msg.correlationId, status)
}

export async function handleMailSendExternal(
  msg: ApiCallFor<'cms.mail.sendExternal'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ template, address, variables, reference }] = msg.args
  const status = await queuePluginMail(db, entry, { template, to: address.trim(), variables, reference })
  replyApiOk(msg.pluginId, msg.correlationId, status)
}

export async function handleSitePublicUrl(
  msg: ApiCallFor<'cms.site.publicUrl'>,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  replyApiOk(msg.pluginId, msg.correlationId, configuredPublicOrigin())
}

/**
 * Tell a plugin what became of an email it queued. Only that plugin's
 * listeners run, and nothing waits for them: a slow listener must not hold
 * up the mail queue. `to` is the recipient exactly as the plugin named it:
 * `{ member }` for a member, whose address it was never given, or the
 * `{ address }` it supplied itself.
 */
export function announcePluginMailOutcome(outcome: QueuedMailOutcome): void {
  const prefix = pluginMailTemplatePrefix(outcome.source)
  const payload = {
    template: outcome.kind.startsWith(prefix) ? outcome.kind.slice(prefix.length) : outcome.kind,
    to: outcome.recipient,
    reference: outcome.reference,
    ...(outcome.status === 'failed' ? { error: outcome.error ?? 'Delivery failed' } : {}),
  }
  const event = outcome.status === 'sent' ? 'mail.delivered' : 'mail.failed'
  void hookBus.emitTo(outcome.source, event, payload).catch((err: unknown) => {
    console.error(`[plugin:${outcome.source}] ${event} hook failed:`, err)
  })
}
