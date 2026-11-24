/**
 * Sending one message now, and waiting for the answer. This is the path for
 * mail whose sender is watching: the admin's "Send test" and connector test.
 * Everything else is queued (`delivery.ts`) and uses `carryThroughConnector`
 * from here for each attempt.
 *
 * Callers hand over a finished message (`sendSiteMail`, usually built with
 * `buildTemplateMail`); this decides how it leaves:
 *
 *  - a default connector and a sender address are set → send through it,
 *    log `sent` / `failed`
 *  - they are not, on a development server → capture it in the activity log
 *    with its body
 *  - they are not, in production → refuse (`MailNotConfiguredError`)
 *
 * Nothing here ever writes a message body to stdout or the server log.
 */
import type { DbClient } from '../db/client'
import {
  MAIL_ADDRESS_PATTERN,
  getMailTemplateDefinition,
  renderMailTemplate,
  type MailActivityStatus,
  type MailDefaults,
  type MailDeliveryMode,
} from '@core/mail'
import { getErrorMessage } from '@core/utils/errorMessage'
import { recordMail } from './activity'
import { noteConnectorUse, resolveConnector, type ResolvedConnector } from './connectors'
import { getMailDefaults } from './defaults'
import { sendViaBrevo, sendViaMailgun, sendViaPostmark, sendViaResend } from './apiDrivers'
import { sendViaSes } from './sesDriver'
import { formatFromHeader, MailDeliveryError, sendViaSmtp, type MailRetry, type OutgoingMail } from './smtpDriver'
import { describeWordingProblem, getMailTemplate, siteMailVariables } from './templates'

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Email is not set up. Add a connector and a sender address in the Email workspace.')
    this.name = 'MailNotConfiguredError'
  }
}

export interface SiteMail extends OutgoingMail {
  /** What the message is, for the activity log: a template key, or `test`. */
  kind: string
  /** Something the owner should know about how this email was made, shown with it in Activity. */
  note?: string
}

export class MailTemplateDisabledError extends Error {
  constructor() {
    super('Sending is turned off for this email template.')
    this.name = 'MailTemplateDisabledError'
  }
}

/** An email was asked for without a value its template's wording uses. */
export class MailVariableMissingError extends Error {
  constructor(key: string, missing: readonly string[]) {
    super(`The "${key}" template needs a value for ${missing.map((name) => `{${name}}`).join(', ')}.`)
    this.name = 'MailVariableMissingError'
  }
}

/** A template that cannot be turned into an email with every value in place. Retrying changes nothing. */
export class MailTemplateInvalidError extends Error {
  constructor(key: string, refused: readonly string[]) {
    super(
      `The "${key}" template cannot be sent: ${refused.map((name) => `{${name}}`).join(', ')} cannot be filled in as it is written.`,
    )
    this.name = 'MailTemplateInvalidError'
  }
}

/** Carries one message through one connector. Replaceable in tests. */
export type MailCarrier = (
  connector: ResolvedConnector,
  sender: { fromAddress: string; fromName: string; fromHeader: string; replyTo: string },
  mail: OutgoingMail,
) => Promise<string | null>

const carryMail: MailCarrier = (connector, sender, mail) => {
  switch (connector.kind) {
    case 'smtp': return sendViaSmtp(connector.config, connector.secret, sender, mail)
    case 'ses': return sendViaSes(connector.config, connector.secret, sender, mail)
    case 'resend': return sendViaResend(connector.secret, sender, mail)
    case 'postmark': return sendViaPostmark(connector.secret, sender, mail)
    case 'mailgun': return sendViaMailgun(connector.config, connector.secret, sender, mail)
    case 'brevo': return sendViaBrevo(connector.secret, sender, mail)
  }
}

export interface SendDeps {
  carrier?: MailCarrier
  env?: Record<string, string | undefined>
}

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

export function captureAllowed(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV !== 'production'
}

/** A connector and a sender address are both needed before anything is sent. */
export function readyToSend(defaults: MailDefaults): defaults is MailDefaults & { defaultConnectorId: string } {
  return defaults.defaultConnectorId !== null && defaults.fromAddress !== ''
}

export function mailDeliveryMode(
  defaults: MailDefaults,
  env: Record<string, string | undefined> = process.env,
): MailDeliveryMode {
  if (readyToSend(defaults)) return 'send'
  return captureAllowed(env) ? 'capture' : 'off'
}

export function assertSendable(mail: SiteMail): void {
  // A recipient or subject carrying a line break could add headers.
  if (!ADDRESS_RE.test(mail.to) || /[\r\n]/.test(mail.to) || /[\r\n]/.test(mail.subject)) {
    throw new MailDeliveryError('The message has an invalid recipient or subject.')
  }
}

/** What one attempt to hand a message to a connector came to. */
export type CarryOutcome =
  | { ok: true; connector: { id: string; label: string }; providerMessageId: string | null; durationMs: number }
  | {
      ok: false
      /** Absent when the connector could not be read at all. */
      connector?: { id: string; label: string }
      error: unknown
      /** The safe sentence for the activity log. */
      message: string
      /** Never `suspect`: this function settles that question. */
      retry: Exclude<MailRetry, 'suspect'>
      /** The provider's refusal was ambiguous: the recipient's fault or the account's. */
      suspect?: true
      durationMs?: number
    }

/**
 * How many different recipients in a row must get an ambiguous refusal
 * (`suspect`) before it is taken to be the account's and not theirs.
 */
const SUSPECT_RECIPIENTS_TO_PAUSE = 3

/** Ambiguous refusals older than this no longer count towards a pause. */
const SUSPECT_WINDOW_MS = 10 * 60 * 1000

/**
 * Per connector, the recipients whose attempts ended in an ambiguous refusal
 * within the last ten minutes with no success in between, and when. In
 * memory and per process on purpose: it only decides how soon a pause is
 * called, and a restart or a second instance merely needs its own three.
 */
const suspectRecipients = new Map<string, Map<string, number>>()

/**
 * Settle an ambiguous refusal. One recipient, however often, is that
 * recipient's trouble: retry the message. Several different recipients in a
 * row, close together, is the account's: pause. (A pause is itself probed
 * every two minutes, so a wrong call costs minutes, not mail.)
 */
function settleSuspect(connectorId: string, recipient: string, now: number): 'later' | 'connector' {
  const seen = suspectRecipients.get(connectorId) ?? new Map<string, number>()
  for (const [address, at] of seen) if (now - at > SUSPECT_WINDOW_MS) seen.delete(address)
  seen.set(recipient.toLowerCase(), now)
  if (seen.size < SUSPECT_RECIPIENTS_TO_PAUSE) {
    suspectRecipients.set(connectorId, seen)
    return 'later'
  }
  // The pause is called; when it lifts, the count starts again.
  suspectRecipients.delete(connectorId)
  return 'connector'
}

/** Test seam: forget the ambiguous refusals seen so far. */
export function __resetSuspectRecipientsForTesting(): void {
  suspectRecipients.clear()
}

/**
 * Hand one message to a connector, once. Never throws for a delivery
 * problem: the outcome says what happened and whether it is worth retrying.
 * It writes the connector's last-use note and nothing else, so the direct
 * path and the queue each keep their own record.
 */
export async function carryThroughConnector(
  db: DbClient,
  connectorId: string,
  defaults: MailDefaults,
  mail: OutgoingMail,
  carrier: MailCarrier = carryMail,
  now: number = Date.now(),
  /**
   * False for an email that already got an ambiguous refusal: it has had its
   * say about the connector. Trying it again must not add up to a pause, or
   * a few junk addresses, retried, would pause delivery over and over.
   */
  countsTowardsPause = true,
): Promise<CarryOutcome> {
  let connector: ResolvedConnector | null
  try {
    connector = await resolveConnector(db, connectorId)
  } catch (err) {
    const message = getErrorMessage(err, 'Connector secret unreadable')
    await noteConnectorUse(db, connectorId, message)
    // A secret that cannot be read is the connector's fault, for the owner to put right.
    return { ok: false, error: err, message, retry: 'connector' }
  }
  if (!connector) {
    const error = new MailNotConfiguredError()
    return { ok: false, error, message: error.message, retry: 'connector' }
  }

  const sender = {
    fromAddress: defaults.fromAddress,
    fromName: defaults.fromName,
    fromHeader: formatFromHeader(defaults.fromName, defaults.fromAddress),
    replyTo: defaults.replyTo,
  }
  const used = { id: connector.id, label: connector.label }
  const startedAt = Date.now()
  try {
    const providerMessageId = await carrier(connector, sender, mail)
    // The account evidently works: earlier ambiguous refusals were their recipients'.
    suspectRecipients.delete(connector.id)
    await noteConnectorUse(db, connector.id, null)
    return { ok: true, connector: used, providerMessageId, durationMs: Date.now() - startedAt }
  } catch (err) {
    const message = getErrorMessage(err, 'Delivery failed')
    await noteConnectorUse(db, connector.id, message)
    // A driver says how its refusal should be retried; anything else it
    // throws is not a refusal, and is worth another try.
    const raw = err instanceof MailDeliveryError ? err.retry : 'later'
    const retry = raw !== 'suspect' ? raw : countsTowardsPause ? settleSuspect(connector.id, mail.to, now) : 'later'
    return {
      ok: false,
      connector: used,
      error: err,
      message,
      retry,
      ...(raw === 'suspect' ? { suspect: true as const } : {}),
      durationMs: Date.now() - startedAt,
    }
  }
}

/** Send now, log the result, and throw when it did not leave. */
async function deliver(
  db: DbClient,
  connectorId: string,
  defaults: MailDefaults,
  mail: SiteMail,
  carrier: MailCarrier,
): Promise<void> {
  const log = { kind: mail.kind, to: mail.to, subject: mail.subject }
  const outcome = await carryThroughConnector(db, connectorId, defaults, mail, carrier)
  if (outcome.ok) {
    await recordMail(db, {
      ...log,
      status: 'sent',
      connector: outcome.connector,
      providerMessageId: outcome.providerMessageId,
      durationMs: outcome.durationMs,
    })
    return
  }
  // A connector that is gone was never asked: there is no attempt to log.
  if (!(outcome.error instanceof MailNotConfiguredError)) {
    await recordMail(db, {
      ...log,
      status: 'failed',
      connector: outcome.connector,
      error: outcome.message,
      durationMs: outcome.durationMs,
    })
  }
  throw outcome.error
}

/**
 * Send one finished message. Resolves with how it left (`sent` or
 * `captured`); throws `MailNotConfiguredError`, `MailSecretUnreadableError`
 * or `MailDeliveryError` when it did not.
 */
export async function sendSiteMail(db: DbClient, mail: SiteMail, deps: SendDeps = {}): Promise<MailActivityStatus> {
  assertSendable(mail)
  const defaults = await getMailDefaults(db)
  if (!readyToSend(defaults)) {
    if (!captureAllowed(deps.env ?? process.env)) throw new MailNotConfiguredError()
    await recordMail(db, { kind: mail.kind, to: mail.to, subject: mail.subject, status: 'captured', body: mail.text })
    return 'captured'
  }
  await deliver(db, defaults.defaultConnectorId, defaults, mail, deps.carrier ?? carryMail)
  return 'sent'
}

/**
 * Send a test message through one specific connector, whether or not it is
 * the default. Needs a sender address, since a provider will not accept
 * mail without one.
 */
export async function sendConnectorTest(
  db: DbClient,
  connectorId: string,
  mail: SiteMail,
  deps: SendDeps = {},
): Promise<void> {
  assertSendable(mail)
  const defaults = await getMailDefaults(db)
  if (defaults.fromAddress === '') {
    throw new MailDeliveryError('Set a sender address under Defaults before testing a connector.')
  }
  await deliver(db, connectorId, defaults, mail, deps.carrier ?? carryMail)
}

/** Render a template (with the owner's edits) into a finished message. */
export async function buildTemplateMail(
  db: DbClient,
  input: { key: string; to: string; variables: Record<string, string> },
  /**
   * `accept` (the default) is an email being asked for: a variable its
   * wording uses and the caller did not give is the caller's mistake, and
   * throws. `deliver` is an email already queued: the wording may have
   * changed since, so the built-in wording is tried before giving up.
   */
  when: 'accept' | 'deliver' = 'accept',
): Promise<SiteMail> {
  const template = await getMailTemplate(db, input.key)
  if (!template) throw new Error(`unknown mail template "${input.key}"`)
  if (!template.sendingEnabled) throw new MailTemplateDisabledError()
  const values = { ...(await siteMailVariables(db)), ...input.variables }
  let rendered = renderMailTemplate(template, values)
  // The owner's wording cannot be sent as written: a link that does not
  // stand alone, a name in braces that is not a variable, or (for an email
  // already queued) a variable the email was queued without.
  const wording = describeWordingProblem(rendered)
  const lacks = when === 'deliver' && rendered.missing.length > 0
  let note: string | undefined
  if ((wording !== null || lacks) && template.customised) {
    // The built-in wording is sent instead, and the log says so.
    const definition = getMailTemplateDefinition(input.key)
    if (definition) {
      const needs = rendered.missing.map((name) => `{${name}}`).join(', ')
      note = `Your wording was not used: ${wording ?? `it needs ${needs}, which this email was queued without.`} The built-in wording was sent.`
      rendered = renderMailTemplate(
        { key: input.key, subject: definition.defaultSubject, body: definition.defaultBody, variables: template.variables },
        values,
      )
    }
  }
  // Never an email with braces left in it.
  if (rendered.unknown.length > 0 || rendered.refused.length > 0) {
    throw new MailTemplateInvalidError(input.key, [...rendered.unknown, ...rendered.refused])
  }
  if (rendered.missing.length > 0) throw new MailVariableMissingError(input.key, rendered.missing)
  return {
    kind: input.key,
    to: input.to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    ...(note ? { note } : {}),
  }
}
