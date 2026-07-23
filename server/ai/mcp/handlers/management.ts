/** Admin management API for MCP connections and personal access tokens. */
import { getErrorMessage } from '@core/utils/errorMessage'
import { CreateMcpAccessTokenBodySchema } from '@core/ai'
import { jsonResponse, readValidatedBody, badRequest } from '../../../http'
import { requireCapability, requireStepUp, userHasCapability } from '../../../auth/authz'
import { expectedOrigin } from '../../../auth/security'
import type { DbClient } from '../../../db/client'
import { createAuditEvent } from '../../../repositories/audit'
import {
  createBearerConnection,
  listConnectorsForUser,
  revokeConnector,
  toConnectionView,
} from '../connectors/store'
import { generatePersonalAccessToken, hashMcpSecret } from '../connectors/token'
import { MCP_ENDPOINT_PATH } from '../paths'
import { isRemoteMcpEndpoint } from '../oauth/protocol'

const CONNECTIONS_BASE = '/admin/api/ai/mcp/connections'
const ACCESS_TOKENS_PATH = '/admin/api/ai/mcp/access-tokens'

export function tryHandleAiMcpManagement(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (
    pathname !== CONNECTIONS_BASE &&
    !pathname.startsWith(`${CONNECTIONS_BASE}/`) &&
    pathname !== ACCESS_TOKENS_PATH
  ) {
    return null
  }
  return handle(req, db, pathname)
}

async function handle(req: Request, db: DbClient, pathname: string): Promise<Response> {
  if (pathname === CONNECTIONS_BASE) {
    return req.method === 'GET'
      ? handleList(req, db)
      : jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  if (pathname === ACCESS_TOKENS_PATH) {
    return req.method === 'POST'
      ? handleCreateAccessToken(req, db)
      : jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  if (req.method === 'DELETE') {
    return handleRevoke(req, db, pathname.slice(`${CONNECTIONS_BASE}/`.length))
  }
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleList(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  const records = await listConnectorsForUser(db, userOrResponse.id)
  const endpoint = `${expectedOrigin(req)}${MCP_ENDPOINT_PATH}`
  return jsonResponse({
    connections: records.map(toConnectionView),
    endpoint,
    remoteAccess: isRemoteMcpEndpoint(endpoint) ? 'public-https' : 'local-only',
  })
}

async function handleCreateAccessToken(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, CreateMcpAccessTokenBodySchema)
  if (!body) return badRequest('Invalid request body.')
  const label = body.label.trim()
  if (!label) return badRequest('Label is required.')

  const capabilities = [...new Set(body.capabilities)]
  if (userHasCapability(userOrResponse, 'ai.chat') && !capabilities.includes('ai.chat')) {
    capabilities.push('ai.chat')
  }
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
    const accessToken = generatePersonalAccessToken()
    const record = await createBearerConnection(db, {
      userId: userOrResponse.id,
      label,
      capabilities,
      tokenHash: await hashMcpSecret(accessToken),
      ttlDays: body.ttlDays,
    })
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.mcp_connector.created',
      targetType: 'ai_mcp_connector',
      targetId: record.id,
      metadata: {
        label: record.label,
        authMode: record.authMode,
        capabilities: [...record.capabilities],
      },
    })
    return jsonResponse({ connection: toConnectionView(record), accessToken }, { status: 201 })
  } catch (err) {
    console.error('[ai:mcp] failed to create access token:', err)
    return jsonResponse({ error: getErrorMessage(err, 'Failed to create access token.') }, { status: 500 })
  }
}

async function handleRevoke(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  if (!id) return badRequest('Missing connection id.')

  const revoked = await revokeConnector(db, id, userOrResponse.id)
  if (!revoked) return jsonResponse({ error: 'Connection not found.' }, { status: 404 })

  await createAuditEvent(db, {
    actorUserId: userOrResponse.id,
    action: 'ai.mcp_connector.revoked',
    targetType: 'ai_mcp_connector',
    targetId: id,
  })
  return jsonResponse({ revoked: true })
}
