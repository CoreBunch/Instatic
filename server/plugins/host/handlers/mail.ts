import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import type { HostPluginRecord } from '../types'
import { replyApiOk } from '../apiReplies'
import { hostMatchesAllowlist, isBlockedAddress } from '../network'

/** Resolve once and connect to that IP, while preserving the hostname for TLS. */
export async function resolveSmtpAddress(
  host: string,
  resolve: (host: string) => Promise<Array<{ address: string }>> = async (name) => lookup(name, { all: true }),
): Promise<string> {
  if (isIP(host)) throw new Error('SMTP host must be a hostname')
  const addresses = await resolve(host)
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new Error('SMTP host does not resolve exclusively to public addresses')
  }
  return addresses.find((entry) => isIP(entry.address) === 4)?.address ?? addresses[0].address
}

export function assertAllowedSmtpHost(
  host: string,
  port: 465 | 587,
  secure: boolean,
  allowedHosts: readonly string[],
): string {
  const normalized = host.toLowerCase()
  if (!hostMatchesAllowlist(normalized, allowedHosts)) {
    throw new Error(`SMTP host "${normalized}" is not in smtpAllowedHosts`)
  }
  if (secure !== (port === 465)) {
    throw new Error('SMTP port 465 requires TLS; port 587 requires STARTTLS')
  }
  return normalized
}

export async function handleMailSend(
  msg: ApiCallFor<'cms.mail.send'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ transport, message }] = msg.args
  const host = assertAllowedSmtpHost(
    transport.host, transport.port, transport.secure, entry.manifest.smtpAllowedHosts ?? [],
  )

  const address = await resolveSmtpAddress(host)
  const smtp = nodemailer.createTransport({
    host: address,
    port: transport.port,
    secure: transport.secure,
    requireTLS: !transport.secure,
    tls: { servername: host },
    auth: { user: transport.username, pass: transport.password },
    connectionTimeout: 3_000,
    greetingTimeout: 3_000,
    socketTimeout: 8_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })

  try {
    const result = await smtp.sendMail(message)
    replyApiOk(msg.pluginId, msg.correlationId, { messageId: result.messageId })
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
    console.error(`[plugin:${msg.pluginId}] SMTP delivery failed (${code})`)
    throw new Error('SMTP delivery failed', { cause: error })
  } finally {
    smtp.close()
  }
}
