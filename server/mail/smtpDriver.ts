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
 *    password, no permission to send, a sender it has not verified). No
 *    message will get through until the owner fixes the connector, so
 *    delivery pauses instead of retrying.
 *  - `suspect`: a refusal that could be either: providers answer 403 both
 *    for a suspended account and for one blocked, suppressed or
 *    not-yet-allowed recipient. One such answer never pauses anything, since
 *    anyone can cause it by giving an address. `carryThroughConnector`
 *    retries the message and pauses only when several different recipients
 *    in a row get it.
 */
export type MailRetry = 'never' | 'later' | 'slow-down' | 'connector' | 'suspect'

export class MailDeliveryError extends Error {
  readonly retry: MailRetry
  constructor(message: string, options?: ErrorOptions & { retry?: MailRetry }) {
    super(message, options)
    this.name = 'MailDeliveryError'
    this.retry = options?.retry ?? 'never'
  }
}

/**
 * How an HTTP provider's refusal should be retried when its body says
 * nothing more specific (each driver looks at the body first). 401 is always
 * the key. 403 is not: it is also how providers refuse one recipient.
 */
export function retryForHttpStatus(status: number): MailRetry {
  if (status === 429) return 'slow-down'
  if (status === 401) return 'connector'
  if (status === 403) return 'suspect'
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

/** A 4yz reply whose text is the server throttling the account, not deferring one recipient. */
const SMTP_THROTTLE_TEXT = /\b4\.7\.\d+\b.*\b(rate|too many|throttl|limit|quota)|\b(rate limit|too many (messages|connections|emails)|throttl)/i

/** A reply that speaks of one recipient, whatever else it says. */
const SMTP_RECIPIENT_TEXT = /\b(recipient|rcpt|mailbox|addressee|user)\b/i

/**
 * SMTP reply classes. The reply code is read before the error's `code`:
 * a server that answers a login with 454 ("temporary authentication
 * failure", "too many login attempts") is having a bad minute, and
 * nodemailer still calls that `EAUTH`. So:
 *
 *  - any 4yz is temporary. 421 (the server closing the connection on the
 *    whole account) and a 4yz whose text speaks of rate or quota, and not
 *    of a recipient, slow everything down; every other 4yz, 450 / 451 / 452 greylisting and a
 *    full mailbox included, retries that message alone. Anyone can cause
 *    one of those by giving an address, so it never holds other mail back.
 *  - 535 or `EAUTH` (a refused login), 530 (authentication required) and a
 *    server that offers no TLS are the connector's fault.
 *  - any other 5yz is a verdict on the message.
 */
export function retryForSmtpFailure(err: unknown): MailRetry {
  const code = err instanceof Error && 'code' in err ? String(err.code) : ''
  const responseCode = err instanceof Error && 'responseCode' in err ? Number(err.responseCode) : 0
  const response = err instanceof Error && 'response' in err ? String(err.response) : ''
  if (responseCode >= 400 && responseCode < 500) {
    if (responseCode === 421) return 'slow-down'
    // A throttle on one recipient ("450 4.7.1 ... Recipient address rejected:
    // rate limited") is that recipient's: anyone can cause it by giving an
    // address, so it must not hold everyone else's mail back.
    const command = err instanceof Error && 'command' in err ? String(err.command) : ''
    const aboutRecipient = /^RCPT\b/i.test(command) || SMTP_RECIPIENT_TEXT.test(response)
    return SMTP_THROTTLE_TEXT.test(response) && !aboutRecipient ? 'slow-down' : 'later'
  }
  if (code === 'EAUTH' || responseCode === 535 || responseCode === 530 || code === 'ETLS') return 'connector'
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
