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
import {
  RequestBodyTooLargeError,
  readTextBodyWithLimit,
} from '../../../http'
import { resolveMcpAuth, unauthorizedResponse } from '../auth'
import { buildMcpServer } from '../server'
import { MCP_ENDPOINT_PATH } from '../paths'

const DEFAULT_MCP_REQUEST_MAX_BYTES = 68 * 1024 * 1024

interface McpHttpOptions {
  uploadsDir?: string
  /** Test seam; production uses the hard endpoint-wide limit above. */
  maxRequestBytes?: number
}

function payloadTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `MCP request body exceeds ${maxBytes} bytes`,
      },
      id: null,
    },
    { status: 413 },
  )
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

  if (req.method.toUpperCase() !== 'POST') return handler.fetch(req)

  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MCP_REQUEST_MAX_BYTES
  let rawBody: string
  try {
    rawBody = await readTextBodyWithLimit(req, maxRequestBytes)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return payloadTooLargeResponse(maxRequestBytes)
    }
    throw err
  }

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    // Preserve the SDK's canonical JSON-RPC parse-error response. The original
    // request body has been consumed by the bounded read, so replay only this
    // already-bounded string for the SDK to parse.
    const replay = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: rawBody,
      signal: req.signal,
    })
    return handler.fetch(replay)
  }

  // Passing the parsed body avoids a second SDK read/copy of a potentially
  // large inline media payload after the endpoint-wide bound has been applied.
  return handler.fetch(req, { parsedBody })
}
