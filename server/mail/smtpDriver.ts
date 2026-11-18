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
export class MailDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MailDeliveryError'
  }
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
    throw new MailDeliveryError(`The SMTP host "${host}" could not be resolved.`, { cause: err })
  }
  if (addresses.length === 0) {
    throw new MailDeliveryError(`The SMTP host "${host}" could not be resolved.`)
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
    throw new MailDeliveryError(describeSmtpFailure(err), { cause: err })
  } finally {
    smtp.close()
  }
}
