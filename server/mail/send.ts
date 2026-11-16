/**
 * The one entry point for mail the server itself sends (account emails, test
 * messages). Callers hand over a finished message; this decides how it leaves:
 *
 *  - an SMTP account is saved      → send through it, log `sent` / `failed`
 *  - none saved, development server → capture it in the outbox with its body
 *  - none saved, production server  → refuse (`MailNotConfiguredError`)
 *
 * Nothing here ever writes a message body to stdout or the server log.
 */
import type { DbClient } from '../db/client'
import { MAIL_ADDRESS_PATTERN, type MailDeliveryMode, type MailOutboxStatus } from '@core/mail'
import { getErrorMessage } from '@core/utils/errorMessage'
import { recordMail } from './outbox'
import { resolveMailAccount, type ResolvedMailAccount } from './settings'
import { MailDeliveryError, sendViaSmtp, type OutgoingMail, type SmtpSender } from './transport'

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Email is not set up. Add an SMTP account in Settings → Email.')
    this.name = 'MailNotConfiguredError'
  }
}

export interface SiteMail extends OutgoingMail {
  /** What the message is, for the delivery log: `test`, `member.verify`, … */
  kind: string
}

interface SendMailDeps {
  smtp?: SmtpSender
  env?: Record<string, string | undefined>
}

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

function captureAllowed(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV !== 'production'
}

export function mailDeliveryMode(
  hasAccount: boolean,
  env: Record<string, string | undefined> = process.env,
): MailDeliveryMode {
  if (hasAccount) return 'smtp'
  return captureAllowed(env) ? 'capture' : 'off'
}

/**
 * Send one message. Resolves with how it left (`sent` or `captured`); throws
 * `MailNotConfiguredError` or `MailDeliveryError` when it did not.
 */
export async function sendSiteMail(
  db: DbClient,
  mail: SiteMail,
  deps: SendMailDeps = {},
): Promise<MailOutboxStatus> {
  // A recipient or subject carrying a line break could add headers.
  if (!ADDRESS_RE.test(mail.to) || /[\r\n]/.test(mail.to) || /[\r\n]/.test(mail.subject)) {
    throw new MailDeliveryError('The message has an invalid recipient or subject.')
  }
  const env = deps.env ?? process.env
  const log = { kind: mail.kind, to: mail.to, subject: mail.subject }

  let account: ResolvedMailAccount | null
  try {
    account = await resolveMailAccount(db)
  } catch (err) {
    await recordMail(db, { ...log, status: 'failed', error: getErrorMessage(err, 'Mail account unreadable') })
    throw err
  }

  if (!account) {
    if (!captureAllowed(env)) throw new MailNotConfiguredError()
    await recordMail(db, { ...log, status: 'captured', body: mail.text })
    return 'captured'
  }

  try {
    await (deps.smtp ?? sendViaSmtp)(account, mail)
  } catch (err) {
    await recordMail(db, { ...log, status: 'failed', error: getErrorMessage(err, 'Delivery failed') })
    throw err
  }
  await recordMail(db, { ...log, status: 'sent' })
  return 'sent'
}
