import type { DbClient } from '../../../db/client'
import {
  jsonResponse,
  methodNotAllowed,
  readValidatedBody,
  RequestBodyTooLargeError,
} from '../../../http'
import { parseAllowedRedirectUri } from '../../../oauth/protocol'
import {
  consumeOAuthRateLimit,
  handleOAuthTokenRequest,
  oauthError,
  privateJsonResponse,
} from '../../../oauth/tokenEndpoint'
import {
  MCP_AUTHORIZATION_SERVER_METADATA_PATH,
  MCP_PATH_PROTECTED_RESOURCE_METADATA_PATH,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
} from '../paths'
import {
  MCP_OAUTH_ISSUER_UNAVAILABLE_MESSAGE,
  mcpIssuerUnavailableResponse,
  mcpOAuthEndpoints,
  mcpResource,
  MCP_OAUTH_SUPPORTED_SCOPES,
} from './protocol'
import {
  OAuthClientRegistrationRequestSchema,
  type OAuthClientRegistrationRequest,
} from './schemas'
import { mcpOAuthRealm, registerOAuthClient } from './store'
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
  if (!endpoints) return mcpIssuerUnavailableResponse()
  return metadataResponse({
    resource: endpoints.resource,
    resource_name: 'Instatic MCP',
    authorization_servers: [endpoints.issuer],
    scopes_supported: [...MCP_OAUTH_SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  })
}

function authorizationServerMetadata(req: Request): Response {
  const endpoints = mcpOAuthEndpoints(req)
  if (!endpoints) return mcpIssuerUnavailableResponse()
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
  const limited = consumeOAuthRateLimit(req, oauthRegistrationRateLimit)
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

function handleTokenRequest(req: Request, db: DbClient): Promise<Response> {
  return handleOAuthTokenRequest(req, db, {
    realm: mcpOAuthRealm,
    limiter: oauthTokenRateLimit,
    resource: mcpResource(req),
    issuerUnavailableMessage: MCP_OAUTH_ISSUER_UNAVAILABLE_MESSAGE,
    resourceMismatchMessage: 'The requested resource does not match this MCP server.',
  })
}

function metadataResponse(body: unknown): Response {
  return jsonResponse(body, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
