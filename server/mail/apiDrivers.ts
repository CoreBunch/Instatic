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
import { MailDeliveryError, retryForHttpStatus, type MailRetry, type OutgoingMail } from './smtpDriver'

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

/**
 * What a provider's own error body says about whose fault a refusal is.
 * Undefined when the body says nothing the status does not.
 */
type Classify = (status: number, json: unknown) => MailRetry | undefined

/**
 * A 403 whose own text names the recipient is that recipient's: a blocked,
 * suppressed, unsubscribed or bounced address, or one a testing account may
 * not write to. It must never count towards pausing the connector.
 */
const RECIPIENT_REFUSAL_TEXT =
  /\b(recipients?|suppress\w*|unsubscrib\w*|bounced?|blocklist\w*|blacklist\w*|testing emails|your own email address|not allowed to send to|inactive)\b/i

/** Send the request and hand back the parsed JSON answer of a success. */
async function post(
  request: ApiRequest,
  readError: (json: unknown) => string | undefined,
  classify: Classify,
  deps: ApiDeps,
): Promise<unknown> {
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
    throw new MailDeliveryError(`Could not reach ${request.provider}. Check the server's network.`, { cause: err, retry: 'later' })
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
  throw new MailDeliveryError(describeFailure(request.provider, res.status, shortReason(readError(json))), {
    retry: classify(res.status, json) ?? retryForBareStatus(res.status, readError(json) ?? ''),
  })
}

/** What the status says when the provider's error code did not settle it. */
function retryForBareStatus(status: number, message: string): MailRetry {
  if (status === 403 && RECIPIENT_REFUSAL_TEXT.test(message)) return 'never'
  return retryForHttpStatus(status)
}

function field<T extends TSchema>(schema: T, json: unknown, read: (value: Static<T>) => string | undefined): string | undefined {
  const parsed = safeParseValue(schema, json)
  return parsed.ok ? read(parsed.value) : undefined
}

// ─── Resend ────────────────────────────────────────────────────────────────

const ResendSentSchema = Type.Object({ id: Type.Optional(Type.String()) })
const ResendErrorSchema = Type.Object({ message: Type.Optional(Type.String()), name: Type.Optional(Type.String()) })

/** Resend error names that are about the API key, whatever the recipient. */
const RESEND_KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key'])

/**
 * Resend names its errors. A key error is the connector's. Its 403
 * `validation_error` is not: it covers both a sending domain that is not
 * verified and "you can only send testing emails to your own address",
 * which is one recipient's.
 */
/** Resend's rate and quota errors: the account as a whole must slow down. */
const RESEND_THROTTLE_ERRORS = new Set(['rate_limit_exceeded', 'daily_quota_exceeded', 'monthly_quota_exceeded'])

export const classifyResendError: Classify = (_status, json) => {
  const name = field(ResendErrorSchema, json, (value) => value.name)
  if (name === undefined) return undefined
  if (RESEND_KEY_ERRORS.has(name)) return 'connector'
  if (RESEND_THROTTLE_ERRORS.has(name)) return 'slow-down'
  return undefined
}

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
    classifyResendError,
    deps,
  )
  return field(ResendSentSchema, json, (value) => value.id) ?? null
}

// ─── Postmark ──────────────────────────────────────────────────────────────

const PostmarkSentSchema = Type.Object({ MessageID: Type.Optional(Type.String()) })
const PostmarkErrorSchema = Type.Object({ Message: Type.Optional(Type.String()), ErrorCode: Type.Optional(Type.Number()) })

/**
 * Postmark answers 422 with an `ErrorCode`. These are about the account or
 * the sender, so every email would get them: 10 (bad or missing server
 * token), 400 (sender signature not found), 401 (sender signature not
 * confirmed), 405 (not allowed to send: out of credits).
 */
const POSTMARK_ACCOUNT_CODES = new Set([10, 400, 401, 405])
/**
 * These are about one recipient: 300 (invalid email request), 406 (inactive
 * recipient: bounced or complained), 412 (account pending approval, so only
 * recipients on the sender's own domain are allowed).
 */
const POSTMARK_RECIPIENT_CODES = new Set([300, 406, 412])

export const classifyPostmarkError: Classify = (_status, json) => {
  const code = safeParseValue(PostmarkErrorSchema, json)
  if (!code.ok || code.value.ErrorCode === undefined) return undefined
  if (POSTMARK_ACCOUNT_CODES.has(code.value.ErrorCode)) return 'connector'
  if (POSTMARK_RECIPIENT_CODES.has(code.value.ErrorCode)) return 'never'
  return undefined
}

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
    classifyPostmarkError,
    deps,
  )
  return field(PostmarkSentSchema, json, (value) => value.MessageID) ?? null
}

// ─── Mailgun ───────────────────────────────────────────────────────────────

const MailgunSentSchema = Type.Object({ id: Type.Optional(Type.String()) })
const MailgunErrorSchema = Type.Object({ message: Type.Optional(Type.String()) })

/**
 * Mailgun has no error codes, only a message. Its sandbox refusal ("…add the
 * address to authorized recipients") is one recipient's. Any other 403 is
 * left to the status: it may be a disabled account or a recipient.
 */
export const classifyMailgunError: Classify = (status, json) => {
  if (status !== 403) return undefined
  const message = field(MailgunErrorSchema, json, (value) => value.message) ?? ''
  return /authorized recipients/i.test(message) ? 'never' : undefined
}

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
    classifyMailgunError,
    deps,
  )
  // Mailgun wraps the id in angle brackets, as it appears in the Message-ID header.
  return field(MailgunSentSchema, json, (value) => value.id)?.replace(/^<|>$/g, '') ?? null
}

// ─── Brevo ─────────────────────────────────────────────────────────────────

const BrevoSentSchema = Type.Object({ messageId: Type.Optional(Type.String()) })
const BrevoErrorSchema = Type.Object({ message: Type.Optional(Type.String()), code: Type.Optional(Type.String()) })

/**
 * Brevo answers with a `code`. About the account: `unauthorized` (the key),
 * `account_under_validation`, `not_enough_credits`. Its `permission_denied`
 * is left to the status: it is used for the account and for a recipient.
 */
const BREVO_ACCOUNT_CODES = new Set(['unauthorized', 'account_under_validation', 'not_enough_credits'])

export const classifyBrevoError: Classify = (_status, json) => {
  const code = field(BrevoErrorSchema, json, (value) => value.code)
  if (code === undefined) return undefined
  if (BREVO_ACCOUNT_CODES.has(code)) return 'connector'
  if (code === 'too_many_requests') return 'slow-down'
  return undefined
}

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
    classifyBrevoError,
    deps,
  )
  return field(BrevoSentSchema, json, (value) => value.messageId)?.replace(/^<|>$/g, '') ?? null
}
