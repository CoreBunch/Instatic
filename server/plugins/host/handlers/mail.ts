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
import { cleanMailValue, mailValueProblem } from '@core/mail'
import { hookBus, type MailHookEvent } from '@core/plugins/hookBus'
import { pluginMailTemplateKey, pluginMailTemplatePrefix } from '@core/plugins/manifestMail'
import { configuredPublicOrigin } from '../../../auth/security'
import { queueTemplateMail } from '../../../mail/delivery'
import type { QueuedMailOutcome } from '../../../mail/outcomes'
import { MailLimitError } from '../../../mail/limits'
import { MailNotConfiguredError, MailTemplateInvalidError, MailVariableMissingError } from '../../../mail/send'
import { MailDeliveryError } from '../../../mail/smtpDriver'
import { findMemberById } from '../../../members/repository'
import { ensurePluginInstallId, getPluginInstallId } from '../../../repositories/plugins'
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
function checkedVariables(entry: HostPluginRecord, template: string, variables: Record<string, string>): Record<string, string> {
  const declaration = entry.manifest.mail?.templates.find((candidate) => candidate.key === template)
  if (!declaration) throw new Error(`"${template}" is not an email template this plugin declares`)
  const declared = new Set(declaration.variables.map((variable) => variable.name))
  const unknown = Object.keys(variables).filter((name) => !declared.has(name))
  if (unknown.length > 0) {
    throw new Error(`The "${template}" template has no variable named ${unknown.map((name) => `"${name}"`).join(', ')}`)
  }
  // A value is data of the kind its variable declares, nothing more: the
  // owner approved the template's wording, not whatever a value brings along.
  const checked: Record<string, string> = {}
  for (const variable of declaration.variables) {
    const value = variables[variable.name]
    if (value === undefined) continue
    const problem = mailValueProblem(variable.kind, value)
    if (problem) throw new Error(`variable_not_allowed: the value of "${variable.name}" ${problem}`)
    // What was checked is what is sent.
    checked[variable.name] = cleanMailValue(value)
  }
  return checked
}

async function queuePluginMail(db: DbClient, entry: HostPluginRecord, mail: PluginMail): Promise<'queued' | 'captured'> {
  try {
    return await queueTemplateMail(db, {
      key: pluginMailTemplateKey(entry.manifest.id, mail.template),
      to: mail.to,
      variables: mail.variables,
      source: entry.manifest.id,
      sourceLabel: entry.manifest.name,
      // What becomes of this email is told to this install and no other.
      installId: (await ensurePluginInstallId(db, entry.manifest.id)) ?? undefined,
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
    // The email would have gone out with a variable still in it. Nothing was queued.
    // The wording, as it stands now, uses a variable the plugin did not give. Nothing was queued.
    if (err instanceof MailVariableMissingError) throw new Error(`variable_missing: ${err.message}`, { cause: err })
    if (err instanceof MailTemplateInvalidError) throw new Error(`template_invalid: ${err.message}`, { cause: err })
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
  const checked = checkedVariables(entry, template, variables)
  // `findMemberById` leaves deleted members out; a suspended one is not
  // written to either. One answer for an id that was never a member, a
  // deleted member and a suspended one: `mail.send` does not tell them apart.
  const member = await findMemberById(db, memberId)
  if (!member || member.status !== 'active') throw new Error(MEMBER_REFUSAL)
  // The address is the host's to know. Nothing sent back to the plugin, now
  // or with the outcome, carries it: `mail.send` is not a way to read members.
  const status = await queuePluginMail(db, entry, { template, to: member.email, variables: checked, reference, memberId })
  replyApiOk(msg.pluginId, msg.correlationId, status)
}

export async function handleMailSendExternal(
  msg: ApiCallFor<'cms.mail.sendExternal'>,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [{ template, address, variables, reference }] = msg.args
  const checked = checkedVariables(entry, template, variables)
  const status = await queuePluginMail(db, entry, { template, to: address.trim(), variables: checked, reference })
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
 *
 * The news belongs to the install that queued the email. A plugin id that
 * was uninstalled and installed again is another install, possibly another
 * package altogether, and hears nothing of what its predecessor sent.
 */
export function announcePluginMailOutcome(db: DbClient, outcome: QueuedMailOutcome): void {
  void deliverOutcome(db, outcome).catch((err: unknown) => {
    console.error(`[plugin:${outcome.source}] mail outcome could not be delivered:`, err)
  })
}

async function deliverOutcome(db: DbClient, outcome: QueuedMailOutcome): Promise<void> {
  // Ids, not clocks: the email carries the id of the install that queued it.
  const install = await getPluginInstallId(db, outcome.source)
  if (install === null || outcome.installId !== install) return
  const prefix = pluginMailTemplatePrefix(outcome.source)
  const payload = {
    template: outcome.kind.startsWith(prefix) ? outcome.kind.slice(prefix.length) : outcome.kind,
    to: outcome.recipient,
    reference: outcome.reference,
    // A code, never the provider's sentence, which can quote an address.
    ...(outcome.status === 'failed' ? { reason: outcome.reason ?? 'expired' } : {}),
  }
  const event = outcome.status === 'sent' ? 'mail.delivered' : 'mail.failed'
  if (hookBus.hasListener(outcome.source, event)) emitOutcome(outcome.source, event, payload)
  else holdOutcome(outcome.source, { install, event, payload, heldAt: Date.now() })
}

interface HeldOutcome {
  /** The install the news is for (see `ensurePluginInstallId`). */
  install: string
  event: MailHookEvent
  payload: unknown
  heldAt: number
}

/** A plugin that never listens does not grow this without end: the oldest news goes first. */
const HELD_OUTCOMES_PER_PLUGIN = 500
/** News nobody collected within a day is dropped. */
const HELD_OUTCOME_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * News for a plugin that is not listening at this moment (it is being
 * reloaded, upgraded, or is disabled). Kept in memory and handed over when
 * that same install next subscribes; lost if the server restarts first.
 */
const heldOutcomes = new Map<string, HeldOutcome[]>()

function holdOutcome(pluginId: string, outcome: HeldOutcome): void {
  const fresh = (heldOutcomes.get(pluginId) ?? []).filter(
    (held) => held.install === outcome.install && outcome.heldAt - held.heldAt < HELD_OUTCOME_MAX_AGE_MS,
  )
  fresh.push(outcome)
  heldOutcomes.set(pluginId, fresh.slice(-HELD_OUTCOMES_PER_PLUGIN))
}

function emitOutcome(pluginId: string, event: MailHookEvent, payload: unknown): void {
  void hookBus.emitTo(pluginId, event, payload).catch((err: unknown) => {
    console.error(`[plugin:${pluginId}] ${event} hook failed:`, err)
  })
}

/** The plugin has just subscribed to `event`: hand over what this install missed. */
export async function deliverHeldMailOutcomes(db: DbClient, pluginId: string, event: string): Promise<void> {
  if (!heldOutcomes.has(pluginId)) return
  const install = await getPluginInstallId(db, pluginId)
  const held = heldOutcomes.get(pluginId) ?? []
  const now = Date.now()
  // Anything held for another install of this id, or for too long, is dropped unheard.
  const current = held.filter((outcome) => outcome.install === install && now - outcome.heldAt < HELD_OUTCOME_MAX_AGE_MS)
  const remaining = current.filter((outcome) => outcome.event !== event)
  if (remaining.length === 0) heldOutcomes.delete(pluginId)
  else heldOutcomes.set(pluginId, remaining)
  for (const outcome of current) if (outcome.event === event) emitOutcome(pluginId, outcome.event, outcome.payload)
}

/** An uninstalled plugin has nothing to hear, and a newly installed one nothing to inherit. */
export function forgetHeldMailOutcomes(pluginId: string): void {
  heldOutcomes.delete(pluginId)
}
