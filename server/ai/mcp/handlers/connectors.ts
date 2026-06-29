/**
 * MCP connector CRUD — `/admin/api/ai/mcp/connectors[/:id]`.
 *
 *   GET    /admin/api/ai/mcp/connectors        → list (token-free views)
 *   POST   /admin/api/ai/mcp/connectors        → create (returns token ONCE)
 *   DELETE /admin/api/ai/mcp/connectors/:id     → revoke
 *
 * Gated by `ai.providers.manage` — the same capability that governs the AI
 * Providers tab; managing MCP connectors is the same "manage AI integrations"
 * admin surface. The plaintext token is surfaced exactly once, in the create
 * response; every other shape is the wire-safe `McpConnectorView`.
 *
 * A connector can only grant capabilities the creating admin actually holds —
 * an admin cannot mint a connector more powerful than themselves.
 */
import { getErrorMessage } from '@core/utils/errorMessage'
import { CreateMcpConnectorBodySchema } from '@core/ai'
import { jsonResponse, readValidatedBody, badRequest } from '../../../http'
import { requireCapability, userHasCapability } from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { createAuditEvent } from '../../../repositories/audit'
import {
  createConnector,
  listConnectorsForUser,
  revokeConnector,
  toConnectorView,
} from '../connectors/store'
import { generateConnectorToken, hashConnectorToken } from '../connectors/token'

const BASE = '/admin/api/ai/mcp/connectors'

export function tryHandleAiMcpConnectors(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null
  return handle(req, db, pathname)
}

async function handle(req: Request, db: DbClient, pathname: string): Promise<Response> {
  if (pathname === BASE) {
    if (req.method === 'GET') return handleList(req, db)
    if (req.method === 'POST') return handleCreate(req, db)
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  // /:id
  if (req.method === 'DELETE') return handleRevoke(req, db, pathname.slice(`${BASE}/`.length))
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleList(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  const records = await listConnectorsForUser(db, userOrResponse.id)
  return jsonResponse({ connectors: records.map(toConnectorView) })
}

async function handleCreate(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, CreateMcpConnectorBodySchema)
  if (!body) return badRequest('Invalid request body.')

  // Privilege floor: a connector can only grant capabilities the creator holds.
  const overreach = body.capabilities.filter((cap) => !userHasCapability(userOrResponse, cap))
  if (overreach.length > 0) {
    return jsonResponse(
      { error: `You cannot grant capabilities you don't hold: ${overreach.join(', ')}` },
      { status: 403 },
    )
  }

  try {
    const token = generateConnectorToken()
    const record = await createConnector(db, {
      userId: userOrResponse.id,
      label: body.label,
      type: body.type,
      capabilities: body.capabilities,
      tokenHash: await hashConnectorToken(token),
    })
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.mcp_connector.created',
      targetType: 'ai_mcp_connector',
      targetId: record.id,
      metadata: { label: record.label, type: record.type, capabilities: [...record.capabilities] },
    })
    return jsonResponse({ connector: toConnectorView(record), token }, { status: 201 })
  } catch (err) {
    console.error('[ai:mcp] failed to create connector:', err)
    return jsonResponse({ error: getErrorMessage(err, 'Failed to create connector.') }, { status: 500 })
  }
}

async function handleRevoke(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  if (!id) return badRequest('Missing connector id.')

  const revoked = await revokeConnector(db, id, userOrResponse.id)
  if (!revoked) return jsonResponse({ error: 'Connector not found.' }, { status: 404 })

  await createAuditEvent(db, {
    actorUserId: userOrResponse.id,
    action: 'ai.mcp_connector.revoked',
    targetType: 'ai_mcp_connector',
    targetId: id,
  })
  return jsonResponse({ revoked: true })
}
