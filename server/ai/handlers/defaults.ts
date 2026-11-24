/**
 * Site-wide AI defaults handler.
 *
 *   GET /admin/api/ai/defaults                Returns a record of every scope's
 *                                              default { credentialId, modelId }.
 *   PUT /admin/api/ai/defaults/:scope         Body: { credentialId, modelId }
 *   DELETE /admin/api/ai/defaults/:scope      Clears the scope default.
 */

import { Type } from '@core/utils/typeboxHelpers'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import { clearDefaultForScope, listDefaults, setDefaultForScope } from '../defaults/store'
import type { ToolScope } from '../runtime/types'

const VALID_SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']

export const PutBodySchema = Type.Object({
  credentialId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
})

export function tryHandleAiDefaults(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname === '/admin/api/ai/defaults') {
    return handleList(req, db)
  }
  const match = pathname.match(/^\/admin\/api\/ai\/defaults\/([^/]+)$/)
  if (match) {
    return handleScope(req, db, match[1]!)
  }
  return null
}

async function handleList(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const records = await listDefaults(db)
  // Project into a scope-keyed map; UI groups by scope.
  const defaults: Record<string, { credentialId: string; modelId: string }> = {}
  for (const rec of records) {
    defaults[rec.scope] = { credentialId: rec.credentialId, modelId: rec.modelId }
  }
  return jsonResponse({ defaults })
}

async function handleScope(req: Request, db: DbClient, scope: string): Promise<Response> {
  if (req.method === 'PUT') {
    return handleSet(req, db, scope)
  }
  if (req.method === 'DELETE') {
    return handleClear(req, db, scope)
  }
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

function validateScope(scope: string): Response | null {
  if (VALID_SCOPES.includes(scope as ToolScope)) return null
  return jsonResponse(
    { error: `Unknown scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` },
    { status: 400 },
  )
}

async function handleSet(req: Request, db: DbClient, scope: string): Promise<Response> {
  if (req.method !== 'PUT') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const scopeError = validateScope(scope)
  if (scopeError) return scopeError
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, PutBodySchema)
  if (!body) return badRequest('Invalid request body.')
  const { credentialId, modelId } = body

  try {
    const record = await setDefaultForScope(
      db,
      scope as ToolScope,
      credentialId,
      modelId,
      userOrResponse.id,
    )
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.default.updated',
      targetType: 'ai_default',
      targetId: scope,
      metadata: {
        scope,
        credentialId,
        modelId,
      },
    })
    return jsonResponse({ default: record })
  } catch (err) {
    // FK violation when credentialId doesn't exist or belongs to a
    // different user; surface as 400.
    const message = err instanceof Error ? err.message : 'Failed to set default.'
    if (message.toLowerCase().includes('foreign key') || message.toLowerCase().includes('23503')) {
      return jsonResponse(
        { error: 'Credential not found. Pick an existing credential.' },
        { status: 400 },
      )
    }
    console.error('[ai/defaults] set failed:', err)
    return jsonResponse({ error: 'Failed to set default.' }, { status: 500 })
  }
}

async function handleClear(req: Request, db: DbClient, scope: string): Promise<Response> {
  const scopeError = validateScope(scope)
  if (scopeError) return scopeError
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  await clearDefaultForScope(db, scope as ToolScope)
  await createAuditEvent(db, {
    actorUserId: userOrResponse.id,
    action: 'ai.default.cleared',
    targetType: 'ai_default',
    targetId: scope,
    metadata: { scope },
  })
  return new Response(null, { status: 204 })
}
