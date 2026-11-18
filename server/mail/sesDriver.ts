/**
 * Amazon SES delivery, over the SES v2 HTTP API (`SendEmail`). No AWS SDK:
 * one signed POST, the same way the AI drivers talk to their providers.
 *
 * The request goes to `email.<region>.amazonaws.com`. The region is checked
 * against a strict pattern when the connector is saved, so the host is
 * always an AWS one and nothing a caller supplies can redirect the request.
 */
import { createHash, createHmac } from 'node:crypto'
import type { SesConnectorConfig } from '@core/mail'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { MailDeliveryError, type OutgoingMail } from './smtpDriver'

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

interface SignInput {
  method: string
  host: string
  path: string
  query: string
  /** Extra headers to sign, lower-case names. `host` and `x-amz-date` are added. */
  headers: Record<string, string>
  body: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  /** `YYYYMMDDTHHMMSSZ`. */
  amzDate: string
}

/**
 * AWS Signature Version 4. Returns the `Authorization` header value.
 * Exported for its test, which checks it against AWS's published example.
 */
export function signAwsRequest(input: SignInput): string {
  const date = input.amzDate.slice(0, 8)
  const headers: Record<string, string> = { ...input.headers, host: input.host, 'x-amz-date': input.amzDate }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join('\n')
  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

function amzDateNow(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

const SesErrorSchema = Type.Object({ message: Type.Optional(Type.String()) })
const SesSentSchema = Type.Object({ MessageId: Type.Optional(Type.String()) })

/** A failure sentence safe to show an admin: never the key, never the message body. */
function describeSesFailure(status: number, awsMessage: string): string {
  if (status === 403) return 'Amazon SES rejected the access key or its permissions.'
  if (status === 400 && /not verified/i.test(awsMessage)) {
    return 'Amazon SES has not verified the sender address or domain for this region.'
  }
  if (status === 429) return 'Amazon SES is rate-limiting this account. Try again shortly.'
  if (status === 400) return 'Amazon SES rejected the message (check the sender and recipient addresses).'
  return `Amazon SES refused the message (HTTP ${status}).`
}

export interface SesSender {
  fromAddress: string
  fromHeader: string
  replyTo: string
}

export async function sendViaSes(
  config: SesConnectorConfig,
  secretAccessKey: string,
  sender: SesSender,
  mail: OutgoingMail,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
): Promise<string | null> {
  const host = `email.${config.region}.amazonaws.com`
  const path = '/v2/email/outbound-emails'
  const body = JSON.stringify({
    FromEmailAddress: sender.fromHeader,
    Destination: { ToAddresses: [mail.to] },
    ...(sender.replyTo ? { ReplyToAddresses: [sender.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: mail.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: mail.text, Charset: 'UTF-8' },
          ...(mail.html ? { Html: { Data: mail.html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  })
  const amzDate = amzDateNow((deps.now ?? (() => new Date()))())
  const authorization = signAwsRequest({
    method: 'POST',
    host,
    path,
    query: '',
    headers: { 'content-type': 'application/json' },
    body,
    region: config.region,
    service: 'ses',
    accessKeyId: config.accessKeyId,
    secretAccessKey,
    amzDate,
  })

  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(`https://${host}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amz-date': amzDate, authorization },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch (err) {
    console.error('[mail] SES request failed to complete')
    throw new MailDeliveryError('Could not reach Amazon SES. Check the region and the server\'s network.', { cause: err })
  }
  if (res.ok) {
    try {
      const sent = safeParseValue(SesSentSchema, JSON.parse(await res.text()))
      return sent.ok ? (sent.value.MessageId ?? null) : null
    } catch (_err) {
      // SES accepted the message; an unreadable answer only costs the id.
      return null
    }
  }

  let awsMessage = ''
  try {
    const parsed = safeParseValue(SesErrorSchema, JSON.parse(await res.text()))
    if (parsed.ok) awsMessage = parsed.value.message ?? ''
  } catch (_err) {
    // A non-JSON error body: the status alone decides the sentence.
  }
  console.error(`[mail] SES delivery failed (HTTP ${res.status})`)
  throw new MailDeliveryError(describeSesFailure(res.status, awsMessage))
}
