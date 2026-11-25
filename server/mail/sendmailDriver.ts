/**
 * Delivery through a local sendmail-compatible command, for a deployment
 * whose host already knows how to relay mail (a Postfix that keeps the SMTP
 * credentials and picks the relay by the submitting Unix user). Instatic
 * stores no credentials for it.
 *
 * The command comes from `MAIL_SENDMAIL_PATH`, an absolute path, and from
 * nowhere else: not the admin UI, not the stored connector. Like
 * `MAIL_ALLOW_PRIVATE_HOSTS`, it is an environment setting so that only
 * someone who can already configure the server can make it run a command.
 * nodemailer runs it without a shell, as `path -i -f <from> <recipients>`,
 * and refuses an address that would read as an option.
 */
import { isAbsolute } from 'node:path'
import nodemailer from 'nodemailer'
import { MailDeliveryError, type MailRetry, type OutgoingMail, type SmtpEnvelope } from './smtpDriver'

/** How long the command may take to accept a message. */
const SENDMAIL_TIMEOUT_MS = 30_000

/** The configured command, or null when the operator has not enabled the kind. */
export function sendmailPath(env: Record<string, string | undefined> = process.env): string | null {
  const path = env.MAIL_SENDMAIL_PATH?.trim()
  return path && isAbsolute(path) ? path : null
}

class SendmailTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'
}

function exitStatus(err: unknown): number | null {
  const match = err instanceof Error ? /\bcode (\d+)$/.exec(err.message) : null
  return match ? Number(match[1]) : null
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String(err.code) : ''
}

/**
 * How a failed run is retried. The command is the operator's, so its exit
 * status is read as sysexits.h says:
 *
 *  - the command cannot be run (spawn ENOENT / EACCES, shell 126 / 127), or
 *    is not allowed or not configured to send (77 EX_NOPERM, 78 EX_CONFIG):
 *    the connector's fault, so delivery pauses until it is fixed.
 *  - a timeout, 75 (EX_TEMPFAIL), a signal, or trouble with the service or
 *    the system (69, 71, 73, 74) and the generic 1 that Postfix's `sendmail`
 *    exits with when it cannot queue: nothing says the message is at fault,
 *    so it is retried.
 *  - a verdict on the message (64 usage, 65 data, 67 and 68 unknown
 *    recipient) and any other status: not retried.
 */
export function retryForSendmailFailure(err: unknown): MailRetry {
  const code = errorCode(err)
  if (code === 'ENOENT' || code === 'EACCES') return 'connector'
  if (code === 'ETIMEDOUT') return 'later'
  const status = exitStatus(err)
  if (status === null) return err instanceof Error && /terminated by/.test(err.message) ? 'later' : 'never'
  if (status === 126 || status === 127 || status === 77 || status === 78) return 'connector'
  return [1, 69, 71, 73, 74, 75].includes(status) ? 'later' : 'never'
}

function describeSendmailFailure(err: unknown): string {
  const code = errorCode(err)
  if (code === 'ENOENT' || code === 'EACCES') {
    return 'The sendmail command could not be started. Check that MAIL_SENDMAIL_PATH points to an executable file.'
  }
  if (code === 'ETIMEDOUT') return 'The sendmail command did not finish in time.'
  const status = exitStatus(err)
  if (status === 127 || status === 126) {
    return 'The sendmail command could not be started. Check that MAIL_SENDMAIL_PATH points to an executable file.'
  }
  if (status === 75) return 'The sendmail command could not take the message right now (temporary failure).'
  return status === null
    ? 'The sendmail command did not accept the message.'
    : `The sendmail command refused the message (exit status ${status}).`
}

export async function sendViaSendmail(
  envelope: SmtpEnvelope,
  mail: OutgoingMail,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const path = sendmailPath(env)
  if (!path) {
    throw new MailDeliveryError(
      'The sendmail command is not enabled. Set MAIL_SENDMAIL_PATH on the server to its absolute path.',
      { retry: 'connector' },
    )
  }
  const transport = nodemailer.createTransport({
    sendmail: true,
    path,
    newline: 'unix',
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const info = await Promise.race([
      transport.sendMail({
        from: envelope.fromHeader,
        ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SendmailTimeoutError('sendmail timed out')), SENDMAIL_TIMEOUT_MS)
      }),
    ])
    return typeof info.messageId === 'string' && info.messageId !== '' ? info.messageId : null
  } catch (err) {
    const status = exitStatus(err)
    console.error(`[mail] sendmail delivery failed (${status === null ? errorCode(err) || 'unknown' : `exit ${status}`})`)
    throw new MailDeliveryError(describeSendmailFailure(err), { cause: err, retry: retryForSendmailFailure(err) })
  } finally {
    clearTimeout(timer)
    transport.close()
  }
}
