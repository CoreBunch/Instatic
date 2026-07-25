/**
 * Streamable HTTP MCP endpoint, bridged to Bun's `Bun.serve` Web `Request`/
 * `Response` model.
 *
 * The SDK's `WebStandardStreamableHTTPServerTransport` speaks Web Standards
 * (Request, Response, ReadableStream) natively, so it drops straight into the
 * hand-written router with no Node-compat shim.
 *
 * Stateless-per-request: each request authenticates, builds a capability-scoped
 * MCP server, and runs a single transport exchange with `enableJsonResponse`
 * so the whole result comes back as one JSON body (no long-lived SSE stream to
 * manage in the request/response router). Returns `null` when the path isn't
 * ours, honouring the router's fall-through contract.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { DbClient } from '../../../db/client'
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

  const auth = await resolveMcpAuth(req, db)
  if (!auth.ok) return unauthorizedResponse(req)

  const server = buildMcpServer({
    db,
    userId: auth.userId,
    connectorId: auth.connectorId,
    capabilities: auth.capabilities,
    uploadsDir: options.uploadsDir,
  })

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  })

  try {
    await server.connect(transport)
    return await transport.handleRequest(req)
  } catch (err) {
    console.error('[ai:mcp] transport error:', err)
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  } finally {
    void server.close().catch(() => {})
  }
}
