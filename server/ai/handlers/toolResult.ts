/**
 * POST /admin/api/ai/tool-result
 *
 * Browser-side bridge POST. After applying a write tool against the
 * editor store, the browser sends `{ bridgeId, requestId, result }`. The
 * server matches the bridgeId+requestId to a pending driver waiter via
 * `resolveBridgeToolResult` and resolves it so the driver loop continues.
 *
 * Capability: `ai.tools.write` — this endpoint exists *only* to carry
 * the result of a write tool that mutated the editor store. A user with
 * `ai.chat` but no `ai.tools.write` never gets a write tool registered
 * by `selectToolsForScope`, so the bridge is never invoked. Gating here
 * is defense-in-depth.
 */

import { Type } from '@core/utils/typeboxHelpers'
import { AiToolOutputSchema } from '@core/ai'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { resolveBridgeToolResult } from '../runtime'

const ToolResultBodySchema = Type.Object({
  bridgeId: Type.String({ minLength: 1 }),
  requestId: Type.String({ minLength: 1 }),
  result: AiToolOutputSchema,
  // Optional post-mutation snapshot. The browser sends its current
  // scope snapshot after a mutating tool so subsequent server-side read tools
  // in the same turn see fresh state (loose-typed — scope-specific shape).
  snapshot: Type.Optional(Type.Unknown()),
})

export function tryHandleAiToolResult(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== '/admin/api/ai/tool-result') return null
  return handleAiToolResult(req, db)
}

async function handleAiToolResult(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.tools.write')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, ToolResultBodySchema)
  if (!body) return badRequest('Invalid request body.')
  const { bridgeId, requestId, result, snapshot } = body

  const matched = resolveBridgeToolResult(bridgeId, requestId, result, snapshot)
  if (!matched) {
    // The browser completed work for a turn this runtime no longer owns — most
    // commonly after a server restart. The active chat client must abort its
    // old response instead of silently waiting 90 seconds and letting the
    // model retry the same tool repeatedly.
    return jsonResponse(
      { error: 'The AI tool bridge is no longer active. The server may have restarted; send the message again.' },
      { status: 404 },
    )
  }
  return jsonResponse({ ok: true })
}
