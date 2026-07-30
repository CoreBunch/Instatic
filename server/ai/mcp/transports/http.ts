/**
 * Streamable HTTP MCP endpoint, bridged to Bun's `Bun.serve` Web `Request`/
 * `Response` model.
 *
 * The v2 SDK's `createMcpHandler` speaks Web Standards (Request, Response,
 * ReadableStream) natively, so it drops straight into the hand-written router
 * with no Node-compat shim.
 *
 * Stateless-per-request: every request authenticates before protocol dispatch.
 * The official handler serves stable MCP 2026-07-28 and its default stateless
 * fallback keeps 2025-era initialize clients working on the same endpoint.
 * Modern exchanges use JSON responses because Instatic's current tools do not
 * emit mid-call notifications. Returns `null` when the path isn't ours,
 * honouring the router's fall-through contract.
 */
import {
  createMcpHandler,
  originValidationResponse,
} from '@modelcontextprotocol/server'
import type { DbClient } from '../../../db/client'
import { originAllowed } from '../../../auth/security'
import { resolveMcpAuth, unauthorizedResponse } from '../auth'
import { buildMcpServer } from '../server'
import { MCP_ENDPOINT_PATH } from '../paths'

interface McpHttpOptions {
  uploadsDir?: string
}

export async function handleMcpHttp(
  req: Request,
  db: DbClient,
  options: McpHttpOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== MCP_ENDPOINT_PATH) return null

  // Streamable HTTP requires Origin validation to prevent DNS rebinding. Use
  // Instatic's configured public-origin policy (which also knows the Vite dev
  // origins), then let the SDK shape the standard JSON-RPC rejection.
  if (!originAllowed(req)) {
    return originValidationResponse(req, []) ?? new Response(null, { status: 403 })
  }

  const auth = await resolveMcpAuth(req, db)
  if (!auth.ok) return unauthorizedResponse(req)

  const handler = createMcpHandler(
    () => buildMcpServer({
      db,
      userId: auth.userId,
      connectorId: auth.connectorId,
      capabilities: auth.capabilities,
      uploadsDir: options.uploadsDir,
    }),
    {
      legacy: 'stateless',
      onerror: (err) => console.error('[ai:mcp] transport error:', err),
    },
  )

  return handler.fetch(req)
}
