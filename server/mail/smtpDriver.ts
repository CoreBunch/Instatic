/**
 * SMTP delivery for an SMTP connector.
 *
 * The connection rules follow the plugin network guard (and PR #559's SMTP
 * handling by 7heMech, which this builds on):
 *
 *  - The hostname is resolved once; every answer must be a public address,
 *    and the connection is pinned to the validated IP while TLS still
 *    verifies the original hostname. A DNS answer cannot be swapped between
 *    the check and the connect.
 *  - Port 465 uses implicit TLS; every other port must upgrade with STARTTLS
 *    before authenticating. Credentials never cross the wire in the clear.
 *
 * `MAIL_ALLOW_PRIVATE_HOSTS=1` is the operator's opt-out for a relay on the
 * same machine or private network (Mailpit, a Postfix sidecar): it lifts the
 * public-address rule and makes STARTTLS opportunistic. It is an environment
 * setting, not an admin one, so only someone who can already configure the
 * server can point mail at the internal network.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import { isBlockedAddress } from '../plugins/host/network'
import type { SmtpConnectorConfig } from '@core/mail'

export interface OutgoingMail {
  to: string
  subject: string
  text: string
  html?: string
}

/** A delivery failure safe to show an admin: no credentials, no message body. */
/**
 * Whether a refused message is worth another attempt:
 *
 *  - `never`: the provider judged this message (a bad recipient, a rejected
 *    sender). Sending it again gets the same answer.
 *  - `later`: nothing is wrong with the message. The server could not be
 *    reached, answered with a temporary error, or refused the account's
 *    credentials, which the owner can put right.
 *  - `slow-down`: the provider is rate-limiting the account. Retry later and
 *    hold every other message back meanwhile.
 */
export type MailRetry = 'never' | 'later' | 'slow-down'

export class MailDeliveryError extends Error {
  readonly retry: MailRetry
  constructor(message: string, options?: ErrorOptions & { retry?: MailRetry }) {
    super(message, options)
    this.name = 'MailDeliveryError'
    this.retry = options?.retry ?? 'never'
  }
}

/** How an HTTP provider's refusal should be retried, from its status alone. */
export function retryForHttpStatus(status: number): MailRetry {
  if (status === 429) return 'slow-down'
  // 401/403 are the account's credentials, not the message.
  if (status >= 500 || status === 401 || status === 403 || status === 408) return 'later'
  return 'never'
}

export function privateMailHostsAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MAIL_ALLOW_PRIVATE_HOSTS === '1'
}

type ResolveHost = (host: string) => Promise<Array<{ address: string }>>

const defaultResolveHost: ResolveHost = (host) => lookup(host, { all: true })

/**
 * Resolve the SMTP host to the address the connection is pinned to. Rejects
 * unless every DNS answer is public, so one private record among several
 * cannot be the one the socket picks.
 */
export async function resolveSmtpAddress(
  host: string,
  allowPrivate: boolean,
  resolve: ResolveHost = defaultResolveHost,
): Promise<string> {
  if (isIP(host)) {
    if (!allowPrivate) throw new MailDeliveryError('The SMTP host must be a hostname, not an IP address.')
    return host
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await resolve(host)
  } catch (err) {
    throw new MailDeliveryError(`The SMTP host "${host}" could not be resolved.`, { cause: err, retry: 'later' })
  }
  if (addresses.length === 0) {
    throw new MailDeliveryError(`The SMTP host "${host}" could not be resolved.`, { retry: 'later' })
  }
  if (!allowPrivate && addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new MailDeliveryError(
      `The SMTP host "${host}" resolves to a private address. Set MAIL_ALLOW_PRIVATE_HOSTS=1 on the server to use a local relay.`,
    )
  }
  return (addresses.find((entry) => isIP(entry.address) === 4) ?? addresses[0]).address
}

/** Header-safe display name: quotes and backslashes escaped inside a quoted string. */
export function formatFromHeader(fromName: string, fromAddress: string): string {
  const name = fromName.trim()
  if (!name) return fromAddress
  return `"${name.replace(/["\\]/g, '\\$&')}" <${fromAddress}>`
}

const SMTP_CONNECTION_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS', 'ETLS'])

/**
 * SMTP reply classes: 4yz is "try again later" by definition, 421 and 45x
 * are how servers throttle, and 5yz is a verdict on the message. A failed
 * login (535, `EAUTH`) is the account, so it waits for the owner.
 */
export function retryForSmtpFailure(err: unknown): MailRetry {
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  const responseCode = err instanceof Error && 'responseCode' in err ? Number(err.responseCode) : 0
  if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452) return 'slow-down'
  if (responseCode >= 400 && responseCode < 500) return 'later'
  if (code === 'EAUTH' || responseCode === 535) return 'later'
  if (responseCode >= 500) return 'never'
  return SMTP_CONNECTION_CODES.has(code) ? 'later' : 'never'
}

function describeSmtpFailure(err: unknown): string {
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  const responseCode = err instanceof Error && 'responseCode' in err ? Number(err.responseCode) : 0
  if (code === 'EAUTH' || responseCode === 535) return 'The SMTP server rejected the username or password.'
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED') {
    return 'Could not connect to the SMTP server. Check the host and port.'
  }
  if (code === 'ETLS') return 'The SMTP server did not offer a secure (TLS) connection.'
  if (code === 'EENVELOPE') return 'The SMTP server rejected the sender or recipient address.'
  return responseCode ? `The SMTP server refused the message (code ${responseCode}).` : 'The SMTP server refused the message.'
}

/** Who a message is from, already formatted for a header. */
export interface SmtpEnvelope {
  fromHeader: string
  replyTo: string
}

export async function sendViaSmtp(
  account: SmtpConnectorConfig,
  password: string,
  envelope: SmtpEnvelope,
  mail: OutgoingMail,
): Promise<string | null> {
  const allowPrivate = privateMailHostsAllowed()
  const address = await resolveSmtpAddress(account.host, allowPrivate)
  const implicitTls = account.port === 465
  const smtp = nodemailer.createTransport({
    host: address,
    port: account.port,
    secure: implicitTls,
    requireTLS: !implicitTls && !allowPrivate,
    // SNI and certificate checks use the hostname, never the pinned IP.
    ...(isIP(account.host) ? {} : { tls: { servername: account.host } }),
    ...(account.username ? { auth: { user: account.username, pass: password } } : {}),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  try {
    const info = await smtp.sendMail({
      from: envelope.fromHeader,
      ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    })
    return typeof info.messageId === 'string' && info.messageId !== '' ? info.messageId : null
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
    console.error(`[mail] SMTP delivery failed (${code})`)
    throw new MailDeliveryError(describeSmtpFailure(err), { cause: err, retry: retryForSmtpFailure(err) })
  } finally {
    smtp.close()
  }
}
