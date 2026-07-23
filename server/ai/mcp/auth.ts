/**
 * MCP bearer resolution. The bearer value may be a personal access token or
 * a short-lived OAuth access token; both resolve to the same connector grant
 * and capability set consumed by the tool gate.
 */
import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import { findConnectionByTokenHash, touchConnectorLastUsed } from './connectors/store'
import { hashMcpSecret } from './connectors/token'
import { findOAuthAccessGrant } from './oauth/store'
import { mcpProtectedResourceMetadataUrl, mcpResource, MCP_OAUTH_SCOPE } from './oauth/protocol'

export type McpAuthResult =
  | { ok: true; connectorId: string; userId: string; capabilities: readonly CoreCapability[] }
  | { ok: false }

const BEARER_RE = /^Bearer\s+(.+)$/i

export async function resolveMcpAuth(req: Request, db: DbClient): Promise<McpAuthResult> {
  const match = BEARER_RE.exec((req.headers.get('Authorization') ?? '').trim())
  if (!match) return { ok: false }
  const token = match[1]!.trim()
  const oauthGrant = token.startsWith('imcp_at_')
    ? await findOAuthAccessGrant(db, token, mcpResource(req))
    : null
  if (oauthGrant) {
    stampLastUsed(db, oauthGrant.connectorId)
    return { ok: true, ...oauthGrant }
  }

  const connector = await findConnectionByTokenHash(db, await hashMcpSecret(token))
  if (!connector || !connector.tokenHash) return { ok: false }
  stampLastUsed(db, connector.id)
  return {
    ok: true,
    connectorId: connector.id,
    userId: connector.userId,
    capabilities: connector.capabilities,
  }
}

/**
 * RFC 9728-aware 401. The `resource_metadata` pointer lets spec-compliant
 * clients discover the OAuth authorization server.
 */
export function unauthorizedResponse(req: Request): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${mcpProtectedResourceMetadataUrl(req)}", scope="${MCP_OAUTH_SCOPE}"`,
    },
  })
}

function stampLastUsed(db: DbClient, connectorId: string): void {
  // Best-effort last-used stamp; never block the request on it.
  void touchConnectorLastUsed(db, connectorId).catch((err) => {
    console.error('[ai:mcp] failed to stamp connector last_used_at:', err)
  })
}
