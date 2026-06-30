/**
 * Best-effort default seeding after a new AI credential is created.
 *
 * The first credential should make every AI surface usable without forcing the
 * admin to visit Defaults. Existing defaults are never overwritten.
 */

import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import { listDefaults, setDefaultForScope } from '../defaults/store'
import { resolveDriver } from '../drivers'
import { resolveCredentialForDriver } from './store'
import type { CredentialRecord } from './types'
import type { ToolScope } from '../runtime/types'

const ALL_SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']

export async function seedEmptyDefaults(
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
    const resolved = await resolveCredentialForDriver(db, record)
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

function safeCredentialErrorMessage(
  err: unknown,
  secrets: readonly (string | null | undefined)[] = [],
  fallback = 'Unknown error',
): string {
  const message = err instanceof Error && err.message ? err.message : fallback
  let redacted = message
  for (const secret of secrets) {
    if (!secret) continue
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, '[redacted]')
}
