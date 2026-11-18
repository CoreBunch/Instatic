/**
 * MCP bearer resolution. The bearer value may be a personal access token or
 * a short-lived OAuth access token; both resolve to the same connector grant
 * and capability set consumed by the tool gate.
 */
import type { DbClient } from '../../db/client'
import type { CoreCapability } from '@core/capabilities'
import { findUserById } from '../../repositories/users'
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
  // OAuth access tokens are bound to the exact MCP resource. Without a
  // trustworthy issuer there is no resource to match against, so only
  // personal access tokens (the local-development path) can authenticate.
  const resource = token.startsWith('imcp_at_') ? mcpResource(req) : null
  const oauthGrant = resource ? await findOAuthAccessGrant(db, token, resource) : null
  const connector = oauthGrant ? null : await findConnectionByTokenHash(db, await hashMcpSecret(token))
  const grant = oauthGrant ?? (connector?.tokenHash ? {
    connectorId: connector.id,
    userId: connector.userId,
    capabilities: connector.capabilities,
  } : null)
  if (!grant) return { ok: false }

  // A stored grant is an upper bound, not an account-status or role snapshot.
  // Re-read on every request, including for previously issued OAuth tokens.
  const user = await findUserById(db, grant.userId)
  if (!user || user.status !== 'active' || !user.capabilities.includes('ai.chat')) return { ok: false }
  stampLastUsed(db, grant.connectorId)
  return {
    ok: true,
    ...grant,
    capabilities: grant.capabilities.filter((capability) => user.capabilities.includes(capability)),
  }
}

/**
 * RFC 9728-aware 401. The `resource_metadata` pointer lets spec-compliant
 * clients discover the OAuth authorization server; it is omitted when the
 * deployment has no trustworthy issuer to point at (see `mcpIssuer`), so a
 * spoofed Host header never turns into a discovery URL the server vouches for.
 */
export function unauthorizedResponse(req: Request): Response {
  const metadataUrl = mcpProtectedResourceMetadataUrl(req)
  const challenge = metadataUrl
    ? `Bearer resource_metadata="${metadataUrl}", scope="${MCP_OAUTH_SCOPE}"`
    : `Bearer scope="${MCP_OAUTH_SCOPE}"`
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': challenge,
    },
  })
}

function stampLastUsed(db: DbClient, connectorId: string): void {
  // Best-effort last-used stamp; never block the request on it.
  void touchConnectorLastUsed(db, connectorId).catch((err) => {
    console.error('[ai:mcp] failed to stamp connector last_used_at:', err)
  })
}
