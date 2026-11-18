/**
 * Sending one message now, and waiting for the answer. This is the path for
 * mail whose sender is watching: the admin's "Send test" and connector test.
 * Everything else is queued (`delivery.ts`) and uses `carryThroughConnector`
 * from here for each attempt.
 *
 * Callers either hand over a finished message (`sendSiteMail`) or name a
 * template and its values (`sendTemplateMail`); this decides how it leaves:
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
import { getMailTemplate, siteMailVariables } from './templates'

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Email is not set up. Add a connector and a sender address in the Email workspace.')
    this.name = 'MailNotConfiguredError'
  }
}

export interface SiteMail extends OutgoingMail {
  /** What the message is, for the activity log: a template key, or `test`. */
  kind: string
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
      retry: MailRetry
      durationMs?: number
    }

/** How a failure that is not a delivery refusal should be retried. */
function retryFor(err: unknown): MailRetry {
  // An unreadable secret or a missing connector is the owner's to put right.
  return err instanceof MailDeliveryError ? err.retry : 'later'
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
): Promise<CarryOutcome> {
  let connector: ResolvedConnector | null
  try {
    connector = await resolveConnector(db, connectorId)
  } catch (err) {
    const message = getErrorMessage(err, 'Connector secret unreadable')
    await noteConnectorUse(db, connectorId, message)
    return { ok: false, error: err, message, retry: retryFor(err) }
  }
  if (!connector) {
    const error = new MailNotConfiguredError()
    return { ok: false, error, message: error.message, retry: 'later' }
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
    await noteConnectorUse(db, connector.id, null)
    return { ok: true, connector: used, providerMessageId, durationMs: Date.now() - startedAt }
  } catch (err) {
    const message = getErrorMessage(err, 'Delivery failed')
    await noteConnectorUse(db, connector.id, message)
    return { ok: false, connector: used, error: err, message, retry: retryFor(err), durationMs: Date.now() - startedAt }
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
): Promise<SiteMail> {
  const template = await getMailTemplate(db, input.key)
  if (!template) throw new Error(`unknown mail template "${input.key}"`)
  const rendered = renderMailTemplate(template, { ...(await siteMailVariables(db)), ...input.variables })
  return { kind: input.key, to: input.to, ...rendered }
}
