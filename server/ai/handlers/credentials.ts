/**
 * Credentials handler — GET/POST/PUT/DELETE /admin/api/ai/credentials[/:id]
 *                  + POST /admin/api/ai/credentials/:id/test
 *
 * Every response is the wire-safe `CredentialView` projection. Plaintext +
 * ciphertext + iv NEVER cross the HTTP boundary — gated by
 * `ai-credentials-never-leak.test.ts`.
 */

import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import {
  CredentialError,
  createCredentialForUser,
  deleteCredentialForUser,
  listCredentialsForUser,
  readCredentialForUser,
  resolveCredentialForDriver,
  toCredentialView,
  updateCredentialForUser,
} from '../credentials/store'
import { resolveDriver } from '../drivers'
import type { AiProviderModel } from '../drivers/types'
import type { CredentialRecord } from '../credentials/types'
import { listDefaults, setDefaultForScope } from '../defaults/store'
import type { ToolScope } from '../runtime/types'

const ALL_SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']

const ProviderId = Type.Union([
  Type.Literal('anthropic'),
  Type.Literal('openai'),
  Type.Literal('ollama'),
  Type.Literal('openrouter'),
  Type.Literal('openai-compatible'),
])

const CreateBodySchema = Type.Union([
  Type.Object({
    providerId: ProviderId,
    authMode: Type.Literal('apiKey'),
    displayLabel: Type.String({ minLength: 1 }),
    apiKey: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    providerId: ProviderId,
    authMode: Type.Literal('baseUrl'),
    displayLabel: Type.String({ minLength: 1 }),
    baseUrl: Type.String({ minLength: 1 }),
    apiKey: Type.Optional(Type.String()),
  }),
])

const UpdateBodySchema = Type.Object({
  displayLabel: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String()),
  baseUrl: Type.Optional(Type.String()),
})

// ---------------------------------------------------------------------------
// Router entry
// ---------------------------------------------------------------------------

export function tryHandleAiCredentials(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname === '/admin/api/ai/credentials') {
    return dispatchCollection(req, db)
  }
  const idMatch = pathname.match(/^\/admin\/api\/ai\/credentials\/([^/]+)$/)
  if (idMatch) {
    return dispatchItem(req, db, idMatch[1]!)
  }
  const testMatch = pathname.match(/^\/admin\/api\/ai\/credentials\/([^/]+)\/test$/)
  if (testMatch) {
    return dispatchTest(req, db, testMatch[1]!)
  }
  return null
}

// ---------------------------------------------------------------------------
// Collection: GET (list) + POST (create)
// ---------------------------------------------------------------------------

async function dispatchCollection(req: Request, db: DbClient): Promise<Response> {
  if (req.method === 'GET') return handleList(req, db)
  if (req.method === 'POST') return handleCreate(req, db)
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleList(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse
  const records = await listCredentialsForUser(db, userOrResponse.id)
  const views = await Promise.all(records.map(toCredentialView))
  return jsonResponse({ credentials: views })
}

async function handleCreate(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, CreateBodySchema)
  if (!body) return badRequest('Invalid request body.')

  try {
    const record = await createCredentialForUser(db, userOrResponse.id, body)
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.credential.created',
      targetType: 'ai_credential',
      targetId: record.id,
      metadata: {
        providerId: record.providerId,
        authMode: record.authMode,
        displayLabel: record.displayLabel,
      },
    })
    // Convenience: point any scope that has no default yet at this fresh
    // credential. Never overwrites an existing choice; failures here must not
    // fail credential creation.
    try {
      await seedEmptyDefaults(db, record, userOrResponse.id)
    } catch (err) {
      console.warn(
        '[ai/credentials] auto-default skipped - default seeding failed:',
        safeCredentialErrorMessage(err, bodySecrets(body)),
      )
    }
    return jsonResponse({ credential: await toCredentialView(record) }, { status: 201 })
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    console.error('[ai/credentials] create failed:', safeCredentialErrorMessage(err, bodySecrets(body)))
    return jsonResponse({ error: 'Failed to create credential.' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Auto-default seeding
// ---------------------------------------------------------------------------

/**
 * After a credential is created, assign it as the default for every scope that
 * has no default yet. This is a "fill the blanks" convenience — a scope that
 * already points at some credential is left untouched.
 *
 * The default model is the credential's top live model (the `smartest`-tier
 * entry, else the first). Best-effort: if the model list can't be resolved
 * (offline, bad key) we simply skip seeding rather than fail the create.
 */
async function seedEmptyDefaults(
  db: DbClient,
  record: CredentialRecord,
  userId: string,
): Promise<void> {
  const existing = await listDefaults(db)
  const filled = new Set(existing.map((d) => d.scope))
  const emptyScopes = ALL_SCOPES.filter((scope) => !filled.has(scope))
  if (emptyScopes.length === 0) return

  let topModelId: string | null
  let apiKeyForRedaction: string | null = null
  try {
    const resolved = await resolveCredentialForDriver(record)
    apiKeyForRedaction = resolved.apiKey
    const driver = resolveDriver(record.providerId)
    const models = await driver.listModels(resolved)
    const liveModels = models.filter((model) => model.catalogueSource !== 'fallback')
    const top = liveModels.find((m) => m.tier === 'smartest') ?? liveModels[0]
    topModelId = top?.id ?? null
  } catch (err) {
    console.warn(
      '[ai/credentials] auto-default skipped - model lookup failed:',
      safeCredentialErrorMessage(err, [apiKeyForRedaction]),
    )
    return
  }
  if (!topModelId) {
    console.warn(
      `[ai/credentials] auto-default skipped - no live models resolved for ${record.providerId}/${record.id}.`,
    )
    return
  }

  for (const scope of emptyScopes) {
    await setDefaultForScope(db, scope, record.id, topModelId, userId)
    await createAuditEvent(db, {
      actorUserId: userId,
      action: 'ai.default.updated',
      targetType: 'ai_default',
      targetId: scope,
      metadata: { scope, credentialId: record.id, modelId: topModelId, auto: true },
    })
  }
}

// ---------------------------------------------------------------------------
// Item: PUT (update) + DELETE
// ---------------------------------------------------------------------------

async function dispatchItem(req: Request, db: DbClient, id: string): Promise<Response> {
  if (req.method === 'PUT') return handleUpdate(req, db, id)
  if (req.method === 'DELETE') return handleDelete(req, db, id)
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleUpdate(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, UpdateBodySchema)
  if (!body) return badRequest('Invalid request body.')

  try {
    const record = await updateCredentialForUser(db, userOrResponse.id, id, body)
    if (!record) return jsonResponse({ error: 'Credential not found' }, { status: 404 })
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.credential.updated',
      targetType: 'ai_credential',
      targetId: record.id,
      metadata: {
        providerId: record.providerId,
        displayLabel: record.displayLabel,
        // Only record which fields were touched — never the key itself.
        fieldsTouched: [
          body.displayLabel !== undefined ? 'displayLabel' : null,
          body.apiKey !== undefined ? 'apiKey' : null,
          body.baseUrl !== undefined ? 'baseUrl' : null,
        ].filter((v): v is string => v !== null),
      },
    })
    return jsonResponse({ credential: await toCredentialView(record) })
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    console.error('[ai/credentials] update failed:', safeCredentialErrorMessage(err, bodySecrets(body)))
    return jsonResponse({ error: 'Failed to update credential.' }, { status: 500 })
  }
}

async function handleDelete(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  // Snapshot identity BEFORE the delete so the audit row carries provider +
  // label even though the row no longer exists post-commit.
  const snapshot = await readCredentialForUser(db, userOrResponse.id, id)

  try {
    const deleted = await deleteCredentialForUser(db, userOrResponse.id, id)
    if (!deleted) return jsonResponse({ error: 'Credential not found' }, { status: 404 })
    if (snapshot) {
      await createAuditEvent(db, {
        actorUserId: userOrResponse.id,
        action: 'ai.credential.deleted',
        targetType: 'ai_credential',
        targetId: id,
        metadata: {
          providerId: snapshot.providerId,
          displayLabel: snapshot.displayLabel,
        },
      })
    }
    return jsonResponse({ ok: true })
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    console.error('[ai/credentials] delete failed:', safeCredentialErrorMessage(err))
    return jsonResponse({ error: 'Failed to delete credential.' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Test: POST /admin/api/ai/credentials/:id/test
// ---------------------------------------------------------------------------

async function dispatchTest(req: Request, db: DbClient, id: string): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const record = await readCredentialForUser(db, userOrResponse.id, id)
  if (!record) return jsonResponse({ error: 'Credential not found' }, { status: 404 })

  let apiKeyForRedaction: string | null = null
  try {
    const resolved = await resolveCredentialForDriver(record)
    apiKeyForRedaction = resolved.apiKey
    const driver = resolveDriver(record.providerId)
    const models = await driver.listModels(resolved)
    const modelCount = liveModelCount(models)
    if (modelCount === 0) {
      throw new CredentialError(
        `No live models were returned for ${driver.label}. Check the credential and provider endpoint.`,
        400,
      )
    }
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.credential.tested',
      targetType: 'ai_credential',
      targetId: record.id,
      metadata: {
        providerId: record.providerId,
        displayLabel: record.displayLabel,
        ok: true,
        modelCount,
      },
    })
    return jsonResponse({ ok: true, modelCount })
  } catch (err) {
    const message = safeCredentialErrorMessage(err, [apiKeyForRedaction], 'Test failed.')
    await createAuditEvent(db, {
      actorUserId: userOrResponse.id,
      action: 'ai.credential.tested',
      targetType: 'ai_credential',
      targetId: record.id,
      metadata: {
        providerId: record.providerId,
        displayLabel: record.displayLabel,
        ok: false,
        // Truncated to keep audit metadata bounded — full driver errors
        // can be hundreds of chars.
        error: message.slice(0, 200),
      },
    })
    return jsonResponse({ ok: false, error: message }, { status: 200 })
  }
}

function liveModelCount(models: readonly AiProviderModel[]): number {
  return models.filter((model) => model.catalogueSource !== 'fallback').length
}

function bodySecrets(body: { apiKey?: string }): string[] {
  return body.apiKey ? [body.apiKey] : []
}

function safeCredentialErrorMessage(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
  fallback = 'Unknown error',
): string {
  return redactCredentialSecrets(getErrorMessage(err, fallback), secrets)
}

function redactCredentialSecrets(
  value: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let redacted = value
  for (const secret of secrets) {
    if (!secret) continue
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, '[redacted]')
}
