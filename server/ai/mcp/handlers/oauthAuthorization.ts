/** Admin-session consent surface for the MCP OAuth authorization-code flow. */
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  DecideMcpOAuthAuthorizationBodySchema,
  type McpOAuthAuthorizationRequest,
} from '@core/ai'
import { badRequest, jsonResponse, readValidatedBody } from '../../../http'
import { requireCapability, requireStepUp, userHasCapability } from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { createAuditEvent } from '../../../repositories/audit'
import { createOAuthAuthorizationGrant, findOAuthClient } from '../oauth/store'
import { OAUTH_GRANT_TTL_DAYS } from '../connectors/store'
import {
  isValidPkceChallenge,
  mcpResource,
  normalizeMcpScope,
  oauthRedirect,
} from '../oauth/protocol'
import { parseOAuthAuthorizationRequest } from '../oauth/schemas'
import { MCP_OAUTH_AUTHORIZATION_API_PATH } from '../paths'

export function tryHandleMcpOAuthAuthorization(
  req: Request,
  db: DbClient,
  url: URL,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== MCP_OAUTH_AUTHORIZATION_API_PATH) return null
  if (req.method === 'GET') return handleRead(req, db, url)
  if (req.method === 'POST') return handleDecision(req, db)
  return Promise.resolve(jsonResponse({ error: 'Method not allowed' }, { status: 405 }))
}

async function handleRead(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  const request = parseOAuthAuthorizationRequest(url.searchParams)
  if (!request) return badRequest('Invalid OAuth authorization request.')
  const resolved = await resolveAuthorizationRequest(req, db, request)
  if (!resolved) return badRequest('The OAuth client, callback, scope, or PKCE challenge is invalid.')
  return jsonResponse({
    clientName: resolved.clientName,
    callbackUrl: request.redirectUri,
    grantExpiresInDays: OAUTH_GRANT_TTL_DAYS,
    request: resolved.request,
  })
}

async function handleDecision(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  const body = await readValidatedBody(req, DecideMcpOAuthAuthorizationBodySchema)
  if (!body) return badRequest('Invalid authorization decision.')
  const resolved = await resolveAuthorizationRequest(req, db, body.request)
  if (!resolved) return badRequest('The OAuth authorization request is no longer valid.')

  if (body.decision === 'deny') {
    return jsonResponse({
      redirectUrl: oauthRedirect(body.request.redirectUri, {
        error: 'access_denied',
        error_description: 'The resource owner denied the request.',
        state: body.request.state,
      }),
    })
  }

  const capabilities = [...new Set(body.capabilities ?? [])]
  if (
    userHasCapability(userOrResponse, 'ai.chat') &&
    !capabilities.includes('ai.chat')
  ) {
    capabilities.push('ai.chat')
  }
  if (capabilities.length === 0) return badRequest('Select at least one capability.')
  const overreach = capabilities.filter((capability) => !userHasCapability(userOrResponse, capability))
  if (overreach.length > 0) {
    return jsonResponse(
      { error: `You cannot grant capabilities you don't hold: ${overreach.join(', ')}` },
      { status: 403 },
    )
  }

  const stepUp = await requireStepUp(req, db, userOrResponse)
  if (stepUp) return stepUp

  try {
    const { connection, code } = await createOAuthAuthorizationGrant(db, {
      userId: userOrResponse.id,
      clientName: resolved.clientName,
      capabilities,
      request: resolved.request,
    })
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.mcp_connector.created',
      targetType: 'ai_mcp_connector',
      targetId: connection.id,
      metadata: {
        label: connection.label,
        authMode: connection.authMode,
        clientId: resolved.request.clientId,
        capabilities: [...connection.capabilities],
      },
    })
    return jsonResponse({
      redirectUrl: oauthRedirect(resolved.request.redirectUri, {
        code,
        state: resolved.request.state,
      }),
    })
  } catch (err) {
    console.error('[ai:mcp:oauth] authorization failed:', err)
    return jsonResponse({ error: getErrorMessage(err, 'Failed to authorize MCP connection.') }, { status: 500 })
  }
}

async function resolveAuthorizationRequest(
  req: Request,
  db: DbClient,
  request: McpOAuthAuthorizationRequest,
): Promise<{ clientName: string; request: McpOAuthAuthorizationRequest } | null> {
  const client = await findOAuthClient(db, request.clientId)
  const scope = normalizeMcpScope(request.scope)
  if (
    !client || !scope || !client.redirectUris.includes(request.redirectUri) ||
    !isValidPkceChallenge(request.codeChallenge) ||
    request.resource !== mcpResource(req)
  ) {
    return null
  }
  return { clientName: client.clientName, request: { ...request, scope } }
}
