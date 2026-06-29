/**
 * AI handlers dispatcher — routes `/admin/api/ai/*` requests to the right
 * handler module. The server router calls `tryHandleAi(req, db, url)` and
 * either returns the dispatched Response or null (not an AI route).
 *
 * Order matters: more-specific paths first so `/credentials/:id/test`
 * matches before `/credentials/:id`.
 */

import type { DbClient } from '../../db/client'
import { jsonResponse } from '../../http'
import { isStateChangingMethod, originAllowed } from '../../auth/security'
import { tryHandleAiAudit } from './audit'
import { tryHandleAiChat } from './chat'
import { tryHandleAiToolResult } from './toolResult'
import { tryHandleAiCredentials } from './credentials'
import { tryHandleAiConversations } from './conversations'
import { tryHandleAiDefaults } from './defaults'
import { tryHandleAiModels } from './models'
import { tryHandleAiMcpConnectors } from '../mcp/handlers/connectors'
import { tryHandleAiEditorBridge } from '../mcp/handlers/editorBridge'

export function tryHandleAi(
  req: Request,
  db: DbClient,
  url: URL,
): Promise<Response> | null {
  const pathname = url.pathname
  if (!pathname.startsWith('/admin/api/ai/')) return null

  // Centralised CSRF gate — mirrors handleCmsRequest in server/handlers/cms/index.ts.
  // GETs pass through; state-changing methods (POST/PUT/PATCH/DELETE) require
  // the Origin header to match the expected origin or the dev allowlist.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return Promise.resolve(jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 }))
  }

  // Test endpoints under credentials/:id/test must match BEFORE the
  // generic credentials/:id route — both live inside the credentials
  // handler so the order is handled there.
  return (
    tryHandleAiMcpConnectors(req, db, pathname) ??
    tryHandleAiEditorBridge(req, db, pathname) ??
    tryHandleAiAudit(req, db, url, pathname) ??
    tryHandleAiChat(req, db, pathname) ??
    tryHandleAiToolResult(req, db, pathname) ??
    tryHandleAiCredentials(req, db, pathname) ??
    tryHandleAiConversations(req, db, url, pathname) ??
    tryHandleAiDefaults(req, db, pathname) ??
    tryHandleAiModels(req, db, url, pathname)
  )
}
