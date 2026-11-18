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
 * Whether a refused message is worth another attempt, and whose fault the
 * refusal was:
 *
 *  - `never`: the provider judged this message (a bad recipient, a rejected
 *    sender). Sending it again gets the same answer.
 *  - `later`: nothing is wrong with the message, and the trouble is this
 *    message's or this moment's: the server could not be reached, answered
 *    with a temporary error, or deferred this recipient (greylisting, a full
 *    mailbox). Retry this message; everything else carries on.
 *  - `slow-down`: the provider is throttling the whole account. Retry later
 *    and hold every other message back meanwhile.
 *  - `connector`: the provider refuses the account itself (a wrong key or
 *    password, no permission to send). No message will get through until
 *    the owner fixes the connector, so delivery pauses instead of retrying.
 */
export type MailRetry = 'never' | 'later' | 'slow-down' | 'connector'

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
  // 401/403 are the account's key or its permissions, not the message.
  if (status === 401 || status === 403) return 'connector'
  if (status >= 500 || status === 408) return 'later'
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

const SMTP_CONNECTION_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS'])

/**
 * SMTP reply classes. A failed login (535, `EAUTH`) or a server that offers
 * no TLS is the connector's fault. 421 is the server closing the connection
 * on the whole account ("too many connections", "try later"): slow down.
 * Every other 4yz, 450 / 451 / 452 included, is about this recipient or
 * this message (greylisting, a full mailbox) and anyone can cause one by
 * giving an address, so it retries that message alone and never holds
 * other people's mail back. 5yz is a verdict on the message.
 */
export function retryForSmtpFailure(err: unknown): MailRetry {
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  const responseCode = err instanceof Error && 'responseCode' in err ? Number(err.responseCode) : 0
  if (code === 'EAUTH' || responseCode === 535 || code === 'ETLS') return 'connector'
  if (responseCode === 421) return 'slow-down'
  if (responseCode >= 400 && responseCode < 500) return 'later'
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
