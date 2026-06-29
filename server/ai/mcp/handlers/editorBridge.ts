/**
 * Editor bridge stream — `GET /admin/api/ai/editor-bridge`.
 *
 * The site editor opens this NDJSON stream while mounted so MCP browser tools
 * can be relayed to it (see `../editorBridge.ts`). Authenticated by the admin
 * session; the bridge is registered under the session user, so it can only ever
 * serve that user's own MCP connectors. Results flow back through the existing
 * `POST /admin/api/ai/tool-result` endpoint.
 */
import { jsonResponse } from '../../../http'
import { requireCapability } from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import { createEditorBridgeStream } from '../editorBridge'

const PATH = '/admin/api/ai/editor-bridge'

export function tryHandleAiEditorBridge(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== PATH) return null
  return handle(req, db)
}

async function handle(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  // Hosting the bridge requires being able to view the site — the tools it
  // relays run with this user's editor session.
  const userOrResponse = await requireCapability(req, db, 'site.read')
  if (userOrResponse instanceof Response) return userOrResponse

  const stream = createEditorBridgeStream(userOrResponse.id, req.signal)
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
