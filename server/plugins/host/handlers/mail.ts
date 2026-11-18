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
import { hookBus, type MailHookEvent } from '@core/plugins/hookBus'
import { pluginMailTemplateKey, pluginMailTemplatePrefix } from '@core/plugins/manifestMail'
import { configuredPublicOrigin } from '../../../auth/security'
import { queueTemplateMail, type QueuedMailOutcome } from '../../../mail/delivery'
import { MailLimitError } from '../../../mail/limits'
import { MailNotConfiguredError } from '../../../mail/send'
import { MailDeliveryError } from '../../../mail/smtpDriver'
import { findMemberById } from '../../../members/repository'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

const MEMBER_REFUSAL = 'That member cannot be emailed'

interface PluginMail {
  template: string
  to: string
  variables: Record<string, string>
  reference?: string
  /** Set when the plugin named a member and the host looked the address up. */
  memberId?: string
}

/**
 * Everything about a request that does not depend on who it is for. Checked
 * before a member is looked up, so a refused request says the same thing
 * whether or not the member exists.
 */
function assertDeclaredTemplate(entry: HostPluginRecord, template: string, variables: Record<string, string>): void {
  const declaration = entry.manifest.mail?.templates.find((candidate) => candidate.key === template)
  if (!declaration) throw new Error(`"${template}" is not an email template this plugin declares`)
  const declared = new Set(declaration.variables.map((variable) => variable.name))
  const unknown = Object.keys(variables).filter((name) => !declared.has(name))
  if (unknown.length > 0) {
    throw new Error(`The "${template}" template has no variable named ${unknown.map((name) => `"${name}"`).join(', ')}`)
  }
}

async function queuePluginMail(db: DbClient, entry: HostPluginRecord, mail: PluginMail): Promise<'queued' | 'captured'> {
  try {
    return await queueTemplateMail(db, {
      key: pluginMailTemplateKey(entry.manifest.id, mail.template),
      to: mail.to,
      variables: mail.variables,
      source: entry.manifest.id,
      sourceLabel: entry.manifest.name,
      reference: mail.reference,
      memberId: mail.memberId,
    })
  } catch (err) {
    // These three are written for the caller and name no address. Anything
    // else (a database error, a bug) might: the plugin gets a plain sentence
    // and the detail goes to the server log.
    if (err instanceof MailLimitError || err instanceof MailNotConfiguredError || err instanceof MailDeliveryError) {
      throw err
    }
    console.error(`[plugin:${entry.manifest.id}] mail.send failed:`, err)
    throw new Error('The email could not be queued', { cause: err })
  }
}

export async function handleMailSend(
  msg: ApiCallFor<'cms.mail.send'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ template, member: memberId, variables, reference }] = msg.args
  assertDeclaredTemplate(entry, template, variables)
  // `findMemberById` leaves deleted members out; a suspended one is not
  // written to either. One answer for an id that was never a member, a
  // deleted member and a suspended one: `mail.send` does not tell them apart.
  const member = await findMemberById(db, memberId)
  if (!member || member.status !== 'active') throw new Error(MEMBER_REFUSAL)
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
  assertDeclaredTemplate(entry, template, variables)
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
    // A code, never the provider's sentence, which can quote an address.
    ...(outcome.status === 'failed' ? { reason: outcome.reason ?? 'expired' } : {}),
  }
  const event = outcome.status === 'sent' ? 'mail.delivered' : 'mail.failed'
  if (!hookBus.hasListener(outcome.source, event)) {
    holdOutcome(outcome.source, { event, payload })
    return
  }
  emitOutcome(outcome.source, { event, payload })
}

interface HeldOutcome {
  event: MailHookEvent
  payload: unknown
}

/** A plugin that never listens does not grow this without end: the oldest news goes first. */
const HELD_OUTCOMES_PER_PLUGIN = 500

/**
 * News for a plugin that is not listening at this moment (it is being
 * reloaded, upgraded, or is disabled). Kept in memory and handed over when
 * the plugin next subscribes; lost if the server restarts first.
 */
const heldOutcomes = new Map<string, HeldOutcome[]>()

function holdOutcome(pluginId: string, outcome: HeldOutcome): void {
  const held = heldOutcomes.get(pluginId) ?? []
  held.push(outcome)
  if (held.length > HELD_OUTCOMES_PER_PLUGIN) held.shift()
  heldOutcomes.set(pluginId, held)
}

function emitOutcome(pluginId: string, { event, payload }: HeldOutcome): void {
  void hookBus.emitTo(pluginId, event, payload).catch((err: unknown) => {
    console.error(`[plugin:${pluginId}] ${event} hook failed:`, err)
  })
}

/** The plugin has just subscribed to `event`: hand over what it missed. */
export function deliverHeldMailOutcomes(pluginId: string, event: string): void {
  const held = heldOutcomes.get(pluginId)
  if (!held) return
  const remaining = held.filter((outcome) => outcome.event !== event)
  if (remaining.length === 0) heldOutcomes.delete(pluginId)
  else heldOutcomes.set(pluginId, remaining)
  for (const outcome of held) if (outcome.event === event) emitOutcome(pluginId, outcome)
}

/** An uninstalled plugin has nothing to hear. */
export function forgetHeldMailOutcomes(pluginId: string): void {
  heldOutcomes.delete(pluginId)
}
