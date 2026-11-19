/**
 * The public endpoints of sign-in for apps, `/_instatic/members/oauth/*`,
 * and its discovery document.
 *
 *   GET  authorize   the app opens this in the member's browser. A good
 *                    request is stored and the browser is sent to the page
 *                    the owner picked for approving apps (through sign-in
 *                    first when nobody is signed in). Core has no approval
 *                    screen of its own: no page, no app sign-in.
 *   POST token       code exchange and refresh (public clients, PKCE)
 *   POST revoke      the app signs out (RFC 7009); a sign-in bound to a
 *                    device needs a proof from its key
 *   GET  userinfo    who the member is and what they hold, by access token
 *
 * The member's answer on the approval page is an ordinary member form action
 * (`apps/approve` in `../handlers.ts`), so it rides the same
 * session and same-origin checks as every other member action.
 *
 * None of these read the member session cookie except `authorize`, and none
 * of them changes the account: an app token can only read.
 */
import { MEMBER_APP_SCOPES } from '@core/members'
import type { DbClient } from '../../db/client'
import { RateLimiter } from '../../auth/rateLimit'
import { jsonResponse, methodNotAllowed, readTextBodyWithLimit, setCookieHeader } from '../../http'
import { DPOP_ALGORITHMS, isKeyThumbprint, verifyDpopProof } from '../../oauth/dpop'
import {
  hasDuplicateParameters,
  isValidPkceChallenge,
  oauthRedirect,
  redirectUriRegistered,
} from '../../oauth/protocol'
import {
  consumeOAuthRateLimit,
  handleOAuthTokenRequest,
  oauthError,
  privateJsonResponse,
} from '../../oauth/tokenEndpoint'
import { getMemberPagePaths } from '../pages'
import { findMemberById, listActiveMemberTagExpiries } from '../repository'
import {
  appRequestMarkerCookie,
  createAppRequestMarker,
  findMemberSession,
  readAppRequestMarker,
  readMemberSessionToken,
} from '../sessions'
import {
  MEMBER_OAUTH_AUTHORIZE_PATH,
  MEMBER_OAUTH_ISSUER_UNAVAILABLE_MESSAGE,
  MEMBER_OAUTH_METADATA_PATH,
  MEMBER_OAUTH_REVOKE_PATH,
  MEMBER_OAUTH_TOKEN_PATH,
  MEMBER_OAUTH_USERINFO_PATH,
  cleanDeviceName,
  memberAppIssuer,
  parseMemberAppScope,
} from './protocol'
import { isAvailableMemberAppScope } from './scopes'
import {
  createMemberAppRequest,
  findMemberApp,
  findMemberAppAccess,
  memberAppRealm,
  revokeMemberAppGrantByToken,
  sweepExpiredMemberAppRows,
  touchMemberAppGrant,
} from './store'

const MINUTE = 60 * 1000

/** Per IP. Sign-in is a person clicking; tokens are an app refreshing hourly. */
export const memberAppLimits = {
  authorize: new RateLimiter({ limit: 30, windowMs: 10 * MINUTE }),
  token: new RateLimiter({ limit: 60, windowMs: 10 * MINUTE }),
  revoke: new RateLimiter({ limit: 30, windowMs: 10 * MINUTE }),
}

/** Test seam: forget every recorded attempt. */
export function resetMemberAppLimits(): void {
  for (const limiter of Object.values(memberAppLimits)) limiter.clear()
}

const NO_STORE = { 'cache-control': 'no-store' }
const REVOKE_REQUEST_MAX_BYTES = 8 * 1024

export function handleMemberOAuthRequest(
  req: Request,
  db: DbClient,
  url: URL,
): Promise<Response> | Response {
  switch (url.pathname) {
    case MEMBER_OAUTH_METADATA_PATH:
      return req.method === 'GET' ? metadata(req) : methodNotAllowed()
    case MEMBER_OAUTH_AUTHORIZE_PATH:
      return req.method === 'GET' ? authorize(req, db, url) : methodNotAllowed()
    case MEMBER_OAUTH_TOKEN_PATH:
      return req.method === 'POST' ? token(req, db) : methodNotAllowed()
    case MEMBER_OAUTH_REVOKE_PATH:
      return req.method === 'POST' ? revoke(req, db) : methodNotAllowed()
    case MEMBER_OAUTH_USERINFO_PATH:
      return req.method === 'GET' ? userinfo(req, db) : methodNotAllowed()
    default:
      return jsonResponse({ error: 'Not found' }, { status: 404, headers: NO_STORE })
  }
}

function metadata(req: Request): Response {
  const issuer = memberAppIssuer(req)
  if (!issuer) return jsonResponse({ error: MEMBER_OAUTH_ISSUER_UNAVAILABLE_MESSAGE }, { status: 503 })
  const origin = new URL(issuer).origin
  return jsonResponse(
    {
      issuer,
      authorization_endpoint: `${origin}${MEMBER_OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${origin}${MEMBER_OAUTH_TOKEN_PATH}`,
      revocation_endpoint: `${origin}${MEMBER_OAUTH_REVOKE_PATH}`,
      userinfo_endpoint: `${origin}${MEMBER_OAUTH_USERINFO_PATH}`,
      dpop_signing_alg_values_supported: [...DPOP_ALGORITHMS],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      // The built-in ones only: which plugins a site runs is not for everyone to read.
      scopes_supported: [...MEMBER_APP_SCOPES],
      authorization_response_iss_parameter_supported: true,
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
}

// ─── authorize ─────────────────────────────────────────────────────────────

function plainError(message: string, status: number): Response {
  return jsonResponse({ error: message }, { status, headers: NO_STORE })
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { ...NO_STORE, location } })
}

async function authorize(req: Request, db: DbClient, url: URL): Promise<Response> {
  const limited = consumeOAuthRateLimit(req, memberAppLimits.authorize)
  if (limited) return limited
  const issuer = memberAppIssuer(req)
  if (!issuer) return plainError(MEMBER_OAUTH_ISSUER_UNAVAILABLE_MESSAGE, 503)

  const params = url.searchParams
  if (hasDuplicateParameters(params)) return plainError('The sign-in request names a parameter twice.', 400)

  // Until the app and its redirect URI are known to be registered, nothing
  // may be sent to that URI: the answer is a plain error in the browser.
  const app = await findMemberApp(db, params.get('client_id') ?? '')
  const redirectUri = params.get('redirect_uri') ?? ''
  if (!app || !redirectUriRegistered(app.redirectUris, redirectUri)) {
    return plainError('This app is not registered to sign in on this site.', 400)
  }

  const state = params.get('state') ?? undefined
  const refuse = (error: string, description: string) =>
    redirectTo(oauthRedirect(redirectUri, { error, error_description: description, state, iss: issuer }))

  if (params.get('response_type') !== 'code') {
    return refuse('unsupported_response_type', 'Only the authorization code flow is supported.')
  }
  const codeChallenge = params.get('code_challenge') ?? ''
  if (params.get('code_challenge_method') !== 'S256' || !isValidPkceChallenge(codeChallenge)) {
    return refuse('invalid_request', 'A PKCE S256 code challenge is required.')
  }
  const resource = params.get('resource')
  if (resource !== null && resource !== issuer) {
    return refuse('invalid_target', 'The requested resource is not this site.')
  }
  const scopes = parseMemberAppScope(params.get('scope') ?? undefined)
  if (!scopes || scopes.some((scope) => !app.scopes.includes(scope))) {
    return refuse('invalid_scope', 'The app asked for access it is not registered for.')
  }
  // A plugin scope means something only while its plugin is active and offers it.
  if (scopes.some((scope) => !isAvailableMemberAppScope(scope))) {
    return refuse('invalid_scope', 'The app asked for access this site no longer offers.')
  }

  // The device key the sign-in is bound to, named by its thumbprint.
  const deviceKey = params.get('dpop_jkt')
  if (deviceKey !== null && !isKeyThumbprint(deviceKey)) {
    return refuse('invalid_request', 'dpop_jkt is not a key thumbprint.')
  }

  const pages = await getMemberPagePaths(db)
  if (!pages.appSignIn) {
    return refuse('temporarily_unavailable', 'This site has no page for approving apps yet.')
  }

  await sweepExpiredMemberAppRows(db)
  // The browser the app opened keeps a marker; the answer counts only from
  // it. A well-formed marker that is the only one is kept, so a request still
  // waiting in another tab keeps working. Anything else (none, a malformed
  // value, the name twice) is never sent back: a new one is set. A browser
  // that still presents two afterwards is refused when it answers.
  const browserMarker = readAppRequestMarker(req) ?? createAppRequestMarker()
  const requestId = await createMemberAppRequest(db, {
    appId: app.id,
    browserMarker,
    redirectUri,
    codeChallenge,
    scope: scopes.join(' '),
    resource: issuer,
    state: state ?? null,
    deviceKey,
    deviceName: cleanDeviceName(params.get('device_name')),
  })
  const approval = `${pages.appSignIn}?request=${encodeURIComponent(requestId)}`
  const sessionToken = readMemberSessionToken(req)
  const signedIn = sessionToken ? (await findMemberSession(db, sessionToken)) !== null : false
  // Signed out: go through the owner's sign-in page, which returns to `next`.
  const res = redirectTo(
    signedIn || !pages.login ? approval : `${pages.login}?next=${encodeURIComponent(approval)}`,
  )
  setCookieHeader(res, appRequestMarkerCookie(req, browserMarker))
  return res
}

// ─── token, revoke ─────────────────────────────────────────────────────────

/** An endpoint's full address as an app names it in a DPoP proof; null without a trustworthy origin. */
function endpointAddress(req: Request, path: string): string | null {
  const issuer = memberAppIssuer(req)
  return issuer ? `${new URL(issuer).origin}${path}` : null
}

function token(req: Request, db: DbClient): Promise<Response> {
  return handleOAuthTokenRequest(req, db, {
    realm: memberAppRealm,
    limiter: memberAppLimits.token,
    resource: memberAppIssuer(req),
    issuerUnavailableMessage: MEMBER_OAUTH_ISSUER_UNAVAILABLE_MESSAGE,
    resourceMismatchMessage: 'The requested resource is not this site.',
    dpopEndpoint: endpointAddress(req, MEMBER_OAUTH_TOKEN_PATH) ?? undefined,
  })
}

async function revoke(req: Request, db: DbClient): Promise<Response> {
  const limited = consumeOAuthRateLimit(req, memberAppLimits.revoke)
  if (limited) return limited
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    return oauthError('invalid_request', 'The revocation endpoint requires form-encoded input.', 400)
  }
  let params: URLSearchParams
  try {
    params = new URLSearchParams(await readTextBodyWithLimit(req, REVOKE_REQUEST_MAX_BYTES))
  } catch (_err) {
    // Too large or unreadable: nothing in it can name a token of ours.
    return oauthError('invalid_request', 'Invalid revocation request.', 400)
  }
  const tokenValue = params.get('token') ?? ''
  const clientId = params.get('client_id') ?? ''
  if (!tokenValue || !clientId || hasDuplicateParameters(params)) {
    return oauthError('invalid_request', 'A token and a client_id are required.', 400)
  }
  const proof = req.headers.get('dpop')
  const endpoint = endpointAddress(req, MEMBER_OAUTH_REVOKE_PATH)
  const proofKey = proof && endpoint ? await verifyDpopProof(proof, { method: 'POST', url: endpoint }) : null
  // RFC 7009: the answer is the same whether or not the token was known, or
  // (for a sign-in bound to a device) the caller held its key.
  await revokeMemberAppGrantByToken(db, tokenValue, clientId, proofKey)
  return privateJsonResponse({})
}

// ─── userinfo ──────────────────────────────────────────────────────────────

function unauthorized(): Response {
  return privateJsonResponse(
    { error: 'invalid_token', error_description: 'The access token is missing, expired or revoked.' },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } },
  )
}

function readBearer(req: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get('authorization') ?? '')
  return match ? match[1]! : null
}

async function userinfo(req: Request, db: DbClient): Promise<Response> {
  const resource = memberAppIssuer(req)
  const bearer = readBearer(req)
  if (!resource || !bearer) return unauthorized()
  const access = await findMemberAppAccess(db, bearer, resource)
  const member = access ? await findMemberById(db, access.memberId) : null
  if (!access || !member) return unauthorized()

  const scopes = new Set(access.scope.split(' '))
  const body: Record<string, unknown> = { id: member.id, serverTime: new Date().toISOString() }
  if (scopes.has('profile')) {
    body.email = member.email
    body.emailVerified = member.emailVerifiedAt !== null
    body.name = typeof member.profile.name === 'string' ? member.profile.name : ''
  }
  if (scopes.has('access')) body.tags = await listActiveMemberTagExpiries(db, member.id)
  await touchMemberAppGrant(db, access.grantId)
  return privateJsonResponse(body)
}
