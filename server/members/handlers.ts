/**
 * Public member endpoints — `/_instatic/members/*`.
 *
 * Headless by design: there are no fixed screens here (one bare fallback
 * page aside, see `linkPage.ts`). Every action is one POST that works two
 * ways from the same URL:
 *
 *  - **A plain HTML form** (`application/x-www-form-urlencoded`, no script
 *    needed). The answer is a `303` redirect. Hidden fields `_success` and
 *    `_error` name the site paths to go to; without them the visitor returns
 *    to the page they came from. A failure adds `?member_error=<code>` and,
 *    when one field is at fault, `&member_field=<name>`. A success with no
 *    `_success` adds `?member_ok=<code>`.
 *  - **JSON** (`content-type: application/json`, or `accept: application/json`).
 *    The answer is `{ ok: true, code, member? }` or
 *    `{ ok: false, error: { code, message, field? } }`.
 *
 *   POST signup            email, password, + profile fields
 *   POST verify            token                      (confirmation link)
 *   POST login             email, password
 *   POST logout
 *   POST link/request      email                      (email me a sign-in link)
 *   POST link/confirm      token
 *   POST password/forgot   email
 *   POST password/reset    token, password
 *   POST invite/accept     token, password
 *   POST password/change   currentPassword, newPassword          (signed in)
 *   POST email/change      email, currentPassword                (signed in)
 *   POST email/confirm     token
 *   POST profile           profile fields                        (signed in)
 *   POST delete            currentPassword                       (signed in)
 *   POST apps/disconnect   connection                (signed in; ends one app's sign-in)
 *   POST apps/approve      request, decision          (signed in; answers an app's
 *                          sign-in request: decision is `allow` or `deny`, and a post
 *                          without one is refused, never taken as yes)
 *   *    oauth/*           sign-in for apps, see `apps/handler.ts`
 *   GET  me                { member } or { member: null }
 *   GET  export            the member's own data as a JSON download
 *
 * There is no page here. Sign-in, and every page an emailed link opens, is a
 * page of the site that the owner built and assigned in the member settings.
 *
 * CSRF: every POST must carry an allowed `Origin` and, when the browser
 * sends it, a same-origin `Sec-Fetch-Site`. Together with the `SameSite=Lax`
 * session cookie that covers forms on other sites; the actions that change
 * how an account is reached additionally ask for the current password.
 */
import type { DbClient } from '../db/client'
import type { MemberErrorCode } from '@core/members'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { clientIp, isSiteOrigin, originAllowed } from '../auth/security'
import { jsonResponse, readTextBodyWithLimit, RequestBodyTooLargeError, setCookieHeader } from '../http'
import { answerAppSignIn, disconnectApp } from './apps/approval'
import { handleMemberOAuthRequest } from './apps/handler'
import { MEMBER_OAUTH_PATH_PREFIX } from './apps/protocol'
import { memberLinkOrigin, memberMailAvailable } from './mail'
import { findMemberById, toCurrentMember } from './repository'
import {
  changePassword,
  confirmEmail,
  confirmEmailChange,
  confirmSignInLink,
  deleteAccount,
  exportMemberData,
  logIn,
  logOut,
  requestEmailChange,
  requestPasswordReset,
  requestSignInLink,
  setPasswordWithLink,
  signUp,
  updateProfile,
  type MemberActionContext,
  type MemberOutcome,
  type SignedInMember,
} from './service'
import {
  clearMemberSessionCookie,
  clearSignupNonceCookie,
  findMemberSession,
  memberSessionCookie,
  readAppRequestMarker,
  readMemberSessionToken,
  readSignupNonce,
  signupNonceCookie,
} from './sessions'

export const MEMBERS_PATH_PREFIX = '/_instatic/members/'

const MAX_BODY_BYTES = 16 * 1024
const NO_STORE = { 'cache-control': 'no-store' }

const JsonBodySchema = Type.Record(
  Type.String({ maxLength: 60 }),
  Type.Union([Type.String(), Type.Boolean(), Type.Number()]),
)

// ─── Request reading ───────────────────────────────────────────────────────

type Fields = Record<string, string>

function isJsonRequest(req: Request): boolean {
  return (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
}

function wantsJson(req: Request): boolean {
  if (isJsonRequest(req)) return true
  const accept = (req.headers.get('accept') ?? '').toLowerCase()
  return accept.includes('application/json') && !accept.includes('text/html')
}

/** Read the body as a flat string map, or null when it is not a form or JSON object. */
async function readFields(req: Request): Promise<Fields | null> {
  const text = await readTextBodyWithLimit(req, MAX_BODY_BYTES)
  if (isJsonRequest(req)) {
    let raw: unknown
    try {
      raw = text ? JSON.parse(text) : {}
    } catch {
      return null
    }
    const parsed = safeParseValue(JsonBodySchema, raw)
    if (!parsed.ok) return null
    return Object.fromEntries(Object.entries(parsed.value).map(([key, value]) => [key, String(value)]))
  }
  const fields: Fields = {}
  for (const [key, value] of new URLSearchParams(text)) {
    if (key.length <= 60 && !(key in fields)) fields[key] = value
  }
  return fields
}

/** Same rule as public CMS forms: a browser POST always names its origin. */
export function originOk(req: Request): boolean {
  if (!req.headers.get('origin')) return false
  if (!originAllowed(req)) return false
  const fetchSite = req.headers.get('sec-fetch-site')
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none'
}

/** The signed-in member behind this request, or null. */
export async function resolveSignedInMember(db: DbClient, req: Request): Promise<SignedInMember | null> {
  const token = readMemberSessionToken(req)
  if (!token) return null
  const session = await findMemberSession(db, token)
  if (!session) return null
  const member = await findMemberById(db, session.memberId)
  return member ? { member, session } : null
}

// ─── Redirect targets ──────────────────────────────────────────────────────

/**
 * A site-relative path that is safe to redirect to, or null. Rejects
 * anything a browser could read as another origin (`//host`, `/\host`,
 * a scheme) and anything with control characters.
 */
export function safeRedirectPath(value: string | undefined | null): string | null {
  if (!value || value.length > 600) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null
  const base = 'http://redirect.invalid'
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    return null
  }
  if (url.origin !== base) return null
  // Dot segments can collapse to a path that starts with two slashes
  // (`/.//host`), which a browser reads as another site.
  if (url.pathname.startsWith('//')) return null
  return `${url.pathname}${url.search}${url.hash}`
}

/** The page the form was on, from `Referer`, when it is this site. */
function refererPath(req: Request): string | null {
  const referer = req.headers.get('referer')
  if (!referer) return null
  try {
    const url = new URL(referer)
    if (!isSiteOrigin(req, url.origin)) return null
    return safeRedirectPath(`${url.pathname}${url.search}`)
  } catch {
    return null
  }
}

function withParams(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, 'http://redirect.invalid')
  for (const key of ['member_error', 'member_field', 'member_ok']) url.searchParams.delete(key)
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

// ─── Responses ─────────────────────────────────────────────────────────────

const ERROR_MESSAGES: Record<MemberErrorCode, string> = {
  invalid_input: 'Check the highlighted field and try again.',
  invalid_credentials: 'The email or password is not right.',
  signup_closed: 'Sign-up is closed.',
  invite_required: 'You need an invitation to create an account.',
  invalid_token: 'This link has expired or was already used.',
  weak_password: 'Choose a longer password.',
  email_taken: 'That email address is already in use.',
  reauth_required: 'Sign in again to make this change.',
  not_signed_in: 'Sign in first.',
  rate_limited: 'Too many attempts. Try again later.',
  email_unavailable: 'This site cannot send email right now.',
  not_available: 'This is not available on this site.',
  forbidden_origin: 'This request did not come from this site.',
}

const ERROR_STATUS: Partial<Record<MemberErrorCode, number>> = {
  invalid_credentials: 401,
  not_signed_in: 401,
  reauth_required: 401,
  signup_closed: 403,
  invite_required: 403,
  forbidden_origin: 403,
  rate_limited: 429,
  email_unavailable: 503,
  not_available: 404,
}

function outcomeCookies(req: Request, outcome: MemberOutcome, clearNonce: boolean): string[] {
  const cookies: string[] = []
  const session = outcome.ok ? outcome.session : undefined
  if (session === 'clear') cookies.push(clearMemberSessionCookie(req))
  else if (session) cookies.push(memberSessionCookie(req, session.token, session.expiresAt))
  if (outcome.ok && outcome.signupNonce) cookies.push(signupNonceCookie(req, outcome.signupNonce))
  else if (clearNonce && outcome.ok) cookies.push(clearSignupNonceCookie(req))
  return cookies
}

function respond(
  req: Request,
  fields: Fields,
  outcome: MemberOutcome,
  options: { clearNonce?: boolean } = {},
): Response {
  const res = buildResponse(req, fields, outcome)
  for (const cookie of outcomeCookies(req, outcome, options.clearNonce ?? false)) {
    setCookieHeader(res, cookie)
  }
  return res
}

function buildResponse(req: Request, fields: Fields, outcome: MemberOutcome): Response {
  const headers = new Headers(NO_STORE)
  if (wantsJson(req)) {
    headers.set('content-type', 'application/json; charset=utf-8')
    if (outcome.ok) {
      return new Response(
        JSON.stringify({
          ok: true,
          code: outcome.code,
          ...(outcome.member ? { member: outcome.member } : {}),
          ...(outcome.landing ? { landing: outcome.landing } : {}),
          ...(outcome.appRedirect ? { appRedirect: outcome.appRedirect } : {}),
        }),
        { status: 200, headers },
      )
    }
    if (outcome.retryAfterMs) headers.set('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)))
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: outcome.code,
          message: ERROR_MESSAGES[outcome.code],
          ...(outcome.field ? { field: outcome.field } : {}),
        },
      }),
      { status: ERROR_STATUS[outcome.code] ?? 400, headers },
    )
  }

  const back = refererPath(req) ?? '/'
  let location: string
  if (outcome.ok && outcome.appRedirect) {
    // The one answer that leaves the site: back to the app that asked.
    location = outcome.appRedirect
  } else if (outcome.ok) {
    const chosen = safeRedirectPath(fields._success) ?? safeRedirectPath(outcome.landing)
    location = chosen ? withParams(chosen, {}) : withParams(back, { member_ok: outcome.code })
  } else {
    location = withParams(safeRedirectPath(fields._error) ?? back, {
      member_error: outcome.code,
      member_field: outcome.field,
    })
  }
  headers.set('location', location)
  return new Response(null, { status: 303, headers })
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

async function buildContext(db: DbClient, req: Request): Promise<MemberActionContext> {
  return {
    db,
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
    linkOrigin: memberLinkOrigin(req),
    mailAvailable: await memberMailAvailable(db, req),
  }
}

/** Fields that are part of the protocol, not of a member's profile. */
const RESERVED_FIELDS = new Set([
  'email', 'password', 'token', 'request', 'decision', 'connection', 'currentPassword', 'newPassword', '_success', '_error',
])

function profileFieldsOf(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED_FIELDS.has(key)))
}

async function runAction(
  action: string,
  req: Request,
  db: DbClient,
  fields: Fields,
): Promise<Response | null> {
  const ctx = await buildContext(db, req)
  const ip = ctx.ipAddress ?? 'unknown'
  const field = (name: string) => fields[name] ?? ''
  const signedOut: MemberOutcome = { ok: false, code: 'not_signed_in' }

  switch (action) {
    case 'signup':
      return respond(req, fields, await signUp(ctx, {
        email: field('email'), password: field('password'), fields: profileFieldsOf(fields), ip,
      }))
    case 'verify':
      return respond(req, fields, await confirmEmail(ctx, {
        token: field('token'), signupNonce: readSignupNonce(req), ip,
      }), { clearNonce: true })
    case 'login':
      return respond(req, fields, await logIn(ctx, { email: field('email'), password: field('password'), ip }))
    case 'logout':
      return respond(req, fields, await logOut(ctx, await resolveSignedInMember(db, req)))
    case 'link/request':
      return respond(req, fields, await requestSignInLink(ctx, { email: field('email'), ip }))
    case 'link/confirm':
      return respond(req, fields, await confirmSignInLink(ctx, { token: field('token'), ip }))
    case 'password/forgot':
      return respond(req, fields, await requestPasswordReset(ctx, { email: field('email'), ip }))
    case 'password/reset':
      return respond(req, fields, await setPasswordWithLink(ctx, {
        token: field('token'), password: field('password'), ip,
      }, 'reset'))
    case 'invite/accept':
      return respond(req, fields, await setPasswordWithLink(ctx, {
        token: field('token'), password: field('password'), ip,
      }, 'invite'))
    case 'email/confirm':
      return respond(req, fields, await confirmEmailChange(ctx, { token: field('token'), ip }))
  }

  // Everything below needs a signed-in member.
  if (!['password/change', 'email/change', 'profile', 'delete', 'apps/approve', 'apps/disconnect'].includes(action)) {
    return null
  }
  const current = await resolveSignedInMember(db, req)
  if (!current) return respond(req, fields, signedOut)

  switch (action) {
    case 'password/change':
      return respond(req, fields, await changePassword(ctx, current, {
        currentPassword: fields.currentPassword, newPassword: field('newPassword'),
      }))
    case 'email/change':
      return respond(req, fields, await requestEmailChange(ctx, current, {
        email: field('email'), currentPassword: fields.currentPassword, ip,
      }))
    case 'profile':
      return respond(req, fields, await updateProfile(ctx, current, profileFieldsOf(fields)))
    case 'apps/approve':
      return respond(req, fields, await answerAppSignIn(ctx, current, {
        requestId: field('request'), browserMarker: readAppRequestMarker(req), decision: field('decision'),
      }))
    case 'apps/disconnect':
      return respond(req, fields, await disconnectApp(ctx, current, { connection: field('connection') }))
    default:
      return respond(req, fields, await deleteAccount(ctx, current, {
        currentPassword: fields.currentPassword,
      }))
  }
}

function notFound(): Response {
  return jsonResponse({ error: 'Not found' }, { status: 404, headers: NO_STORE })
}

export async function handleMemberRequest(req: Request, db: DbClient, url: URL): Promise<Response> {
  // Sign-in for apps is called by the app, not by a page of this site: it has
  // its own checks instead of the cookie and same-origin rules below.
  if (url.pathname.startsWith(MEMBER_OAUTH_PATH_PREFIX)) return handleMemberOAuthRequest(req, db, url)
  const action = url.pathname.slice(MEMBERS_PATH_PREFIX.length).replace(/\/+$/, '')

  if (req.method === 'GET') {
    if (action === 'me') {
      const current = await resolveSignedInMember(db, req)
      return jsonResponse(
        { member: current ? await toCurrentMember(db, current.member) : null },
        { headers: NO_STORE },
      )
    }
    if (action === 'export') {
      const current = await resolveSignedInMember(db, req)
      if (!current) return jsonResponse({ error: 'Sign in first.' }, { status: 401, headers: NO_STORE })
      return jsonResponse(await exportMemberData(db, current.member), {
        headers: { ...NO_STORE, 'content-disposition': 'attachment; filename="my-account-data.json"' },
      })
    }
    return notFound()
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405, headers: NO_STORE })
  }
  if (!originOk(req)) {
    return jsonResponse(
      { ok: false, error: { code: 'forbidden_origin', message: ERROR_MESSAGES.forbidden_origin } },
      { status: 403, headers: NO_STORE },
    )
  }

  let fields: Fields | null
  try {
    fields = await readFields(req)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: 'Request too large' }, { status: 413, headers: NO_STORE })
    }
    throw err
  }
  if (!fields) return respond(req, {}, { ok: false, code: 'invalid_input' })

  return (await runAction(action, req, db, fields)) ?? notFound()
}
