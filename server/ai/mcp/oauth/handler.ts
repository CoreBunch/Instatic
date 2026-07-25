import type { DbClient } from '../../../db/client'
import { clientIp } from '../../../auth/security'
import {
  jsonResponse,
  methodNotAllowed,
  readTextBodyWithLimit,
  readValidatedBody,
  RequestBodyTooLargeError,
} from '../../../http'
import {
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_PATH_PROTECTED_RESOURCE_METADATA_PATH,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
} from '../paths'
import {
  mcpOAuthEndpoints,
  mcpResource,
  MCP_OAUTH_SUPPORTED_SCOPES,
  parseAllowedRedirectUri,
} from './protocol'
import {
  OAuthClientRegistrationRequestSchema,
  parseOAuthTokenRequest,
  type OAuthClientRegistrationRequest,
} from './schemas'
import {
  exchangeAuthorizationCode,
  registerOAuthClient,
  rotateRefreshToken,
} from './store'
import { oauthRegistrationRateLimit, oauthTokenRateLimit } from './rateLimit'

const OAUTH_REQUEST_MAX_BYTES = 32 * 1024

export function tryHandleMcpOAuth(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | Response | null {
  if (
    pathname === MCP_PROTECTED_RESOURCE_METADATA_PATH ||
    pathname === MCP_PATH_PROTECTED_RESOURCE_METADATA_PATH
  ) {
    return req.method === 'GET' ? protectedResourceMetadata(req) : methodNotAllowed()
  }
  if (pathname === MCP_AUTHORIZATION_SERVER_METADATA_PATH) {
    return req.method === 'GET' ? authorizationServerMetadata(req) : methodNotAllowed()
  }
  if (pathname === MCP_OAUTH_REGISTER_PATH) {
    return req.method === 'POST' ? handleClientRegistration(req, db) : methodNotAllowed()
  }
  if (pathname === MCP_OAUTH_TOKEN_PATH) {
    return req.method === 'POST' ? handleTokenRequest(req, db) : methodNotAllowed()
  }
  return null
}

function protectedResourceMetadata(req: Request): Response {
  const endpoints = mcpOAuthEndpoints(req)
  return metadataResponse({
    resource: mcpResource(req),
    resource_name: 'Instatic MCP',
    authorization_servers: [endpoints.issuer],
    scopes_supported: [...MCP_OAUTH_SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  })
}

function authorizationServerMetadata(req: Request): Response {
  const endpoints = mcpOAuthEndpoints(req)
  return metadataResponse({
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorizationEndpoint,
    token_endpoint: endpoints.tokenEndpoint,
    registration_endpoint: endpoints.registrationEndpoint,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_OAUTH_SUPPORTED_SCOPES],
  })
}

async function handleClientRegistration(req: Request, db: DbClient): Promise<Response> {
  const limited = consumeRateLimit(req, oauthRegistrationRateLimit)
  if (limited) return limited

  let body: OAuthClientRegistrationRequest | null
  try {
    body = await readValidatedBody(req, OAuthClientRegistrationRequestSchema, {
      maxBytes: OAUTH_REQUEST_MAX_BYTES,
    })
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return oauthError('invalid_client_metadata', 'Client registration is too large.', 400)
    }
    throw err
  }
  if (!body) return oauthError('invalid_client_metadata', 'Invalid client registration.', 400)
  const clientName = body.client_name.trim()
  if (
    !clientName ||
    (body.grant_types !== undefined && !body.grant_types.includes('authorization_code')) ||
    (body.response_types !== undefined && !body.response_types.includes('code')) ||
    body.grant_types?.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token') ||
    body.response_types?.some((responseType) => responseType !== 'code')
  ) {
    return oauthError('invalid_client_metadata', 'Only authorization_code with PKCE is supported.', 400)
  }

  const redirectUris = [...new Set(body.redirect_uris)]
  if (redirectUris.some((uri) => !parseAllowedRedirectUri(uri))) {
    return oauthError(
      'invalid_redirect_uri',
      'Redirect URIs must use HTTPS, or HTTP on a loopback host.',
      400,
    )
  }

  try {
    const client = await registerOAuthClient(db, {
      clientName,
      redirectUris,
    })
    return privateJsonResponse({
      client_id: client.clientId,
      client_id_issued_at: client.clientIdIssuedAt,
      client_name: client.clientName,
      redirect_uris: [...client.redirectUris],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, { status: 201 })
  } catch (err) {
    console.error('[ai:mcp:oauth] client registration failed:', err)
    return oauthError('server_error', 'Client registration failed.', 500)
  }
}

async function handleTokenRequest(req: Request, db: DbClient): Promise<Response> {
  const limited = consumeRateLimit(req, oauthTokenRateLimit)
  if (limited) return limited

  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    return oauthError('invalid_request', 'The token endpoint requires form-encoded input.', 400)
  }
  if (req.headers.has('authorization')) {
    return oauthError('invalid_client', 'This authorization server accepts public clients only.', 401)
  }

  let params: URLSearchParams
  try {
    params = new URLSearchParams(await readTextBodyWithLimit(req, OAUTH_REQUEST_MAX_BYTES))
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
  if (body.resource !== mcpResource(req)) {
    return oauthError('invalid_target', 'The requested resource does not match this MCP server.', 400)
  }

  try {
    const tokens = body.grant_type === 'authorization_code'
      ? await exchangeAuthorizationCode(db, {
          code: body.code,
          clientId: body.client_id,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier,
          resource: body.resource,
        })
      : await rotateRefreshToken(db, {
          refreshToken: body.refresh_token,
          clientId: body.client_id,
          resource: body.resource,
          scope: body.scope,
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
    console.error('[ai:mcp:oauth] token exchange failed:', err)
    return oauthError('server_error', 'Token exchange failed.', 500)
  }
}

function metadataResponse(body: unknown): Response {
  return jsonResponse(body, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}

function oauthError(error: string, description: string, status: number): Response {
  return privateJsonResponse({ error, error_description: description }, { status })
}

function privateJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('Pragma', 'no-cache')
  return jsonResponse(body, { ...init, headers })
}

function consumeRateLimit(
  req: Request,
  limiter: { consume: (key: string) => { ok: boolean; retryAfterMs: number } },
): Response | null {
  const decision = limiter.consume(clientIp(req) ?? 'unknown')
  if (decision.ok) return null
  return privateJsonResponse({ error: 'temporarily_unavailable', error_description: 'Too many requests.' }, {
    status: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))) },
  })
}
