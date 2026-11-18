/**
 * The token endpoint of an OAuth authorization server for public clients:
 * request parsing, the two grants, and the error shapes of RFC 6749 §5.2.
 * Each realm mounts it on its own path with its own limiter and resource.
 */
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import type { RateLimiter } from '../auth/rateLimit'
import { clientIp } from '../auth/security'
import type { DbClient } from '../db/client'
import { jsonResponse, readTextBodyWithLimit, RequestBodyTooLargeError } from '../http'
import { exchangeAuthorizationCode, rotateRefreshToken, type OAuthRealm } from './grants'
import { verifyDpopProof } from './dpop'
import { hasDuplicateParameters } from './protocol'

const TOKEN_REQUEST_MAX_BYTES = 32 * 1024

const AuthorizationCodeTokenRequestSchema = Type.Object({
  grant_type: Type.Literal('authorization_code'),
  code: Type.String({ minLength: 1, maxLength: 2048 }),
  redirect_uri: Type.String({ minLength: 1, maxLength: 4096 }),
  client_id: Type.String({ minLength: 1, maxLength: 2048 }),
  code_verifier: Type.String({ minLength: 43, maxLength: 128 }),
  resource: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: true })

const RefreshTokenRequestSchema = Type.Object({
  grant_type: Type.Literal('refresh_token'),
  refresh_token: Type.String({ minLength: 1, maxLength: 2048 }),
  client_id: Type.String({ minLength: 1, maxLength: 2048 }),
  resource: Type.String({ minLength: 1, maxLength: 4096 }),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: true })

type OAuthTokenRequest =
  | Static<typeof AuthorizationCodeTokenRequestSchema>
  | Static<typeof RefreshTokenRequestSchema>

export function parseOAuthTokenRequest(params: URLSearchParams): OAuthTokenRequest | null {
  if (hasDuplicateParameters(params)) return null
  const raw = Object.fromEntries(params.entries())
  const schema = raw.grant_type === 'authorization_code'
    ? AuthorizationCodeTokenRequestSchema
    : raw.grant_type === 'refresh_token'
      ? RefreshTokenRequestSchema
      : null
  if (!schema) return null
  const parsed = safeParseValue(schema, raw)
  return parsed.ok ? parsed.value : null
}

export async function handleOAuthTokenRequest(
  req: Request,
  db: DbClient,
  options: {
    realm: OAuthRealm
    limiter: RateLimiter
    /** The resource this realm's tokens are bound to, or null when there is no trustworthy issuer. */
    resource: string | null
    issuerUnavailableMessage: string
    resourceMismatchMessage: string
    /**
     * This realm's grants can be bound to a key: the address of this token
     * endpoint, which a DPoP proof must name. Absent, the `DPoP` header is
     * not read.
     */
    dpopEndpoint?: string
  },
): Promise<Response> {
  const limited = consumeOAuthRateLimit(req, options.limiter)
  if (limited) return limited
  // Tokens are bound to the exact resource; without a trustworthy issuer
  // nothing can match, so answer in the token endpoint's own error shape.
  if (!options.resource) {
    return oauthError('temporarily_unavailable', options.issuerUnavailableMessage, 503)
  }

  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    return oauthError('invalid_request', 'The token endpoint requires form-encoded input.', 400)
  }
  if (req.headers.has('authorization')) {
    return oauthError('invalid_client', 'This authorization server accepts public clients only.', 401)
  }

  let params: URLSearchParams
  try {
    params = new URLSearchParams(await readTextBodyWithLimit(req, TOKEN_REQUEST_MAX_BYTES))
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return oauthError('invalid_request', 'The token request is too large.', 400)
    }
    return oauthError('invalid_request', 'Invalid token request.', 400)
  }
  const body = parseOAuthTokenRequest(params)
  if (!body) {
    const grantType = params.get('grant_type')
    return grantType === 'authorization_code' || grantType === 'refresh_token'
      ? oauthError('invalid_request', 'The token request is invalid.', 400)
      : oauthError('unsupported_grant_type', 'The token grant is not supported.', 400)
  }
  if (body.resource !== options.resource) {
    return oauthError('invalid_target', options.resourceMismatchMessage, 400)
  }

  let proofThumbprint: string | null = null
  const proof = options.dpopEndpoint ? req.headers.get('dpop') : null
  if (proof !== null && options.dpopEndpoint) {
    proofThumbprint = await verifyDpopProof(proof, { method: 'POST', url: options.dpopEndpoint })
    if (!proofThumbprint) {
      return oauthError('invalid_dpop_proof', 'The DPoP proof is not valid for this request. Check the device clock.', 400)
    }
  }

  try {
    const tokens = body.grant_type === 'authorization_code'
      ? await exchangeAuthorizationCode(db, options.realm, {
          code: body.code,
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
          resource: body.resource,
          proofThumbprint,
        })
      : await rotateRefreshToken(db, options.realm, {
          refreshToken: body.refresh_token,
          clientId: body.client_id,
          resource: body.resource,
          scope: body.scope,
          proofThumbprint,
        })

    if (!tokens) return oauthError('invalid_grant', 'The authorization grant is invalid or expired.', 400)
    return privateJsonResponse({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: tokens.scope,
    })
  } catch (err) {
    console.error(`[${options.realm.logName}] token exchange failed:`, err)
    return oauthError('server_error', 'Token exchange failed.', 500)
  }
}

export function oauthError(error: string, description: string, status: number): Response {
  return privateJsonResponse({ error, error_description: description }, { status })
}

/** A response that carries a credential or an OAuth error: never cached. */
export function privateJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('Pragma', 'no-cache')
  return jsonResponse(body, { ...init, headers })
}

/** One request against a per-IP limiter; the 429 to send when it is over. */
export function consumeOAuthRateLimit(req: Request, limiter: RateLimiter): Response | null {
  const decision = limiter.consume(clientIp(req) ?? 'unknown')
  if (decision.ok) return null
  return privateJsonResponse({ error: 'temporarily_unavailable', error_description: 'Too many requests.' }, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))) },
  })
}
