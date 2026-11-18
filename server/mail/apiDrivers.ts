/**
 * Delivery through a provider's own HTTP API, for the "one-key" connectors:
 * Resend, Postmark, Mailgun and Brevo. No SDKs: one POST each, like the SES
 * driver and the AI drivers.
 *
 * Every request goes to a host named in this file. The only caller-supplied
 * part of a URL is Mailgun's sending domain, which is checked against a
 * hostname pattern when the connector is saved and is percent-encoded into
 * the path here, so nothing a caller supplies can redirect a request.
 *
 * A failure is turned into a sentence that is safe to show an admin: never
 * the API key and never the message body. The provider's own error text is
 * kept only when it is short, since that is what tells an owner which
 * address or domain to fix.
 */
import type { MailgunConnectorConfig } from '@core/mail'
import { Type, safeParseValue, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { MailDeliveryError, type OutgoingMail } from './smtpDriver'

export interface ApiSender {
  fromAddress: string
  fromHeader: string
  replyTo: string
}

interface ApiDeps {
  fetchImpl?: typeof fetch
}

interface ApiRequest {
  /** The provider's name, for the sentences shown to an admin. */
  provider: string
  url: string
  headers: Record<string, string>
  body: string
}

const PROVIDER_ERROR_MAX = 200

/** One short, single-line piece of the provider's error text, or nothing. */
function shortReason(text: string | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > 0 && line.length <= PROVIDER_ERROR_MAX ? ` ${line}` : ''
}

function describeFailure(provider: string, status: number, reason: string): string {
  if (status === 401 || status === 403) return `${provider} rejected the API key or its permissions.${reason}`
  if (status === 429) return `${provider} is rate-limiting this account. Try again shortly.`
  if (status >= 500) return `${provider} is having trouble right now (HTTP ${status}). Try again shortly.`
  return `${provider} refused the message (HTTP ${status}).${reason}`
}

/** Send the request and hand back the parsed JSON answer of a success. */
async function post(request: ApiRequest, readError: (json: unknown) => string | undefined, deps: ApiDeps): Promise<unknown> {
  let res: Response
  try {
    res = await (deps.fetchImpl ?? fetch)(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
  } catch (err) {
    console.error(`[mail] ${request.provider} request failed to complete`)
    throw new MailDeliveryError(`Could not reach ${request.provider}. Check the server's network.`, { cause: err })
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch (_err) {
    // Not JSON: a success only loses the message id, a failure keeps its status.
  }
  if (res.ok) return json
  console.error(`[mail] ${request.provider} delivery failed (HTTP ${res.status})`)
  throw new MailDeliveryError(describeFailure(request.provider, res.status, shortReason(readError(json))))
}

function field<T extends TSchema>(schema: T, json: unknown, read: (value: Static<T>) => string | undefined): string | undefined {
  const parsed = safeParseValue(schema, json)
  return parsed.ok ? read(parsed.value) : undefined
}

// ─── Resend ────────────────────────────────────────────────────────────────

const ResendSentSchema = Type.Object({ id: Type.Optional(Type.String()) })
const ResendErrorSchema = Type.Object({ message: Type.Optional(Type.String()) })

export async function sendViaResend(apiKey: string, sender: ApiSender, mail: OutgoingMail, deps: ApiDeps = {}): Promise<string | null> {
  const json = await post(
    {
      provider: 'Resend',
      url: 'https://api.resend.com/emails',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: sender.fromHeader,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
      }),
    },
    (error) => field(ResendErrorSchema, error, (value) => value.message),
    deps,
  )
  return field(ResendSentSchema, json, (value) => value.id) ?? null
}

// ─── Postmark ──────────────────────────────────────────────────────────────

const PostmarkSentSchema = Type.Object({ MessageID: Type.Optional(Type.String()) })
const PostmarkErrorSchema = Type.Object({ Message: Type.Optional(Type.String()) })

export async function sendViaPostmark(serverToken: string, sender: ApiSender, mail: OutgoingMail, deps: ApiDeps = {}): Promise<string | null> {
  const json = await post(
    {
      provider: 'Postmark',
      url: 'https://api.postmarkapp.com/email',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-postmark-server-token': serverToken,
      },
      body: JSON.stringify({
        From: sender.fromHeader,
        To: mail.to,
        Subject: mail.subject,
        TextBody: mail.text,
        ...(mail.html ? { HtmlBody: mail.html } : {}),
        ...(sender.replyTo ? { ReplyTo: sender.replyTo } : {}),
        // Sign-in links and the like are transactional mail, Postmark's default stream.
        MessageStream: 'outbound',
      }),
    },
    (error) => field(PostmarkErrorSchema, error, (value) => value.Message),
    deps,
  )
  return field(PostmarkSentSchema, json, (value) => value.MessageID) ?? null
}

// ─── Mailgun ───────────────────────────────────────────────────────────────

const MailgunSentSchema = Type.Object({ id: Type.Optional(Type.String()) })
const MailgunErrorSchema = Type.Object({ message: Type.Optional(Type.String()) })

export async function sendViaMailgun(
  config: MailgunConnectorConfig,
  apiKey: string,
  sender: ApiSender,
  mail: OutgoingMail,
  deps: ApiDeps = {},
): Promise<string | null> {
  const host = config.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'
  const form = new URLSearchParams({ from: sender.fromHeader, to: mail.to, subject: mail.subject, text: mail.text })
  if (mail.html) form.set('html', mail.html)
  if (sender.replyTo) form.set('h:Reply-To', sender.replyTo)
  const json = await post(
    {
      provider: 'Mailgun',
      url: `https://${host}/v3/${encodeURIComponent(config.domain.toLowerCase())}/messages`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`api:${apiKey}`, 'utf8').toString('base64')}`,
      },
      body: form.toString(),
    },
    (error) => field(MailgunErrorSchema, error, (value) => value.message),
    deps,
  )
  // Mailgun wraps the id in angle brackets, as it appears in the Message-ID header.
  return field(MailgunSentSchema, json, (value) => value.id)?.replace(/^<|>$/g, '') ?? null
}

// ─── Brevo ─────────────────────────────────────────────────────────────────

const BrevoSentSchema = Type.Object({ messageId: Type.Optional(Type.String()) })
const BrevoErrorSchema = Type.Object({ message: Type.Optional(Type.String()) })

export async function sendViaBrevo(
  apiKey: string,
  sender: ApiSender & { fromName: string },
  mail: OutgoingMail,
  deps: ApiDeps = {},
): Promise<string | null> {
  const json = await post(
    {
      provider: 'Brevo',
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        sender: { email: sender.fromAddress, ...(sender.fromName ? { name: sender.fromName } : {}) },
        to: [{ email: mail.to }],
        subject: mail.subject,
        textContent: mail.text,
        ...(mail.html ? { htmlContent: mail.html } : {}),
        ...(sender.replyTo ? { replyTo: { email: sender.replyTo } } : {}),
      }),
    },
    (error) => field(BrevoErrorSchema, error, (value) => value.message),
    deps,
  )
  return field(BrevoSentSchema, json, (value) => value.messageId)?.replace(/^<|>$/g, '') ?? null
}
