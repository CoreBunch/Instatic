/**
 * Workspace bridge stream — `GET /admin/api/ai/editor-bridge?scope=…`.
 *
 * The Site editor and Content workspace each open their own newline-delimited
 * JSON stream so MCP browser tools are relayed to the workspace that owns the
 * tool (see `../editorBridge.ts`). The response uses the event-stream media type
 * so reverse proxies flush each record instead of buffering this long-lived
 * connection. Authenticated by the admin session; each bridge is registered
 * under the session user + scope, so it can only serve that user's own MCP
 * connectors. Results flow back through the existing
 * `POST /admin/api/ai/tool-result` endpoint.
 */
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import { jsonResponse } from '../../../http'
import {
  requireAuthenticatedUser,
  userHasAnyCapability,
  userHasCapability,
} from '../../../auth/authz'
import type { DbClient } from '../../../db/client'
import {
  createEditorBridgeStream,
  type EditorBridgeScope,
} from '../editorBridge'

const PATH = '/admin/api/ai/editor-bridge'
const EditorBridgeScopeSchema = Type.Union([
  Type.Literal('site'),
  Type.Literal('content'),
  Type.Literal('plugin'),
])

// Mirrors the Content workspace entry gate in `src/admin/access.ts` and
// `requireDataAccess` in the server's data access layer.
const CONTENT_BRIDGE_CAPABILITIES = [
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
] satisfies CoreCapability[]

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

  const userOrResponse = await requireAuthenticatedUser(req, db)
  if (userOrResponse instanceof Response) return userOrResponse

  const scopeResult = safeParseValue(
    EditorBridgeScopeSchema,
    new URL(req.url).searchParams.get('scope'),
  )
  if (!scopeResult.ok) {
    return jsonResponse(
      { error: 'Query parameter `scope` is required (one of: site, content, plugin)' },
      { status: 400 },
    )
  }
  const scope: EditorBridgeScope = scopeResult.value

  // Hosting a bridge requires access to the workspace whose live state the
  // browser tool will read or mutate.
  const hasWorkspaceAccess =
    scope === 'site' || scope === 'plugin'
      // Plugin IDE entry mirrors its page gate: site.read opens the IDE
      // read-only; write tools re-check plugins.edit in the browser bridge
      // and at tool selection.
      ? userHasCapability(userOrResponse, 'site.read')
      : userHasAnyCapability(userOrResponse, CONTENT_BRIDGE_CAPABILITIES)
  if (!hasWorkspaceAccess) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const stream = createEditorBridgeStream(userOrResponse.id, scope, req.signal)
  return new Response(stream, {
    status: 200,
    headers: {
      // Kamal Proxy flushes event streams incrementally, while generic NDJSON
      // responses may be buffered until this long-lived bridge closes. The
      // browser deliberately parses the payload as newline-delimited JSON.
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
