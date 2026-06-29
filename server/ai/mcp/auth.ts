/**
 * MCP bearer auth. Resolves an incoming request to the connector that owns the
 * presented token, yielding its user id + granted capabilities — which flow
 * straight into the existing tool capability gate.
 *
 * Phase 1 is static bearer tokens. The 401 already advertises a Protected
 * Resource Metadata pointer (`WWW-Authenticate`), so a future OAuth 2.1
 * resource-server mode (for ChatGPT/Gemini managed connectors) drops in
 * without changing how clients discover it.
 */
import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import { findConnectorByTokenHash, touchConnectorLastUsed } from './connectors/store'
import { hashConnectorToken } from './connectors/token'

export type McpAuthResult =
  | { ok: true; connectorId: string; userId: string; capabilities: readonly CoreCapability[] }
  | { ok: false }

const BEARER_RE = /^Bearer\s+(.+)$/i

export async function resolveMcpAuth(req: Request, db: DbClient): Promise<McpAuthResult> {
  const match = BEARER_RE.exec((req.headers.get('Authorization') ?? '').trim())
  if (!match) return { ok: false }
  const connector = await findConnectorByTokenHash(db, await hashConnectorToken(match[1]!.trim()))
  if (!connector || !connector.tokenHash) return { ok: false }
  // Best-effort last-used stamp; never block the request on it.
  void touchConnectorLastUsed(db, connector.id).catch((err) => {
    console.error('[ai:mcp] failed to stamp connector last_used_at:', err)
  })
  return {
    ok: true,
    connectorId: connector.id,
    userId: connector.userId,
    capabilities: connector.capabilities,
  }
}

/**
 * RFC 9728-aware 401. The `resource_metadata` pointer lets spec-compliant
 * clients discover the (future) OAuth authorization server.
 */
export function unauthorizedResponse(url: URL): Response {
  const resourceMetadata = `${url.origin}/.well-known/oauth-protected-resource`
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
    },
  })
}
