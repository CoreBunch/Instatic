/**
 * OpenAI ChatGPT/Codex OAuth device-flow handler.
 *
 * Endpoints:
 *   POST /admin/api/ai/oauth/openai/device/start
 *   POST /admin/api/ai/oauth/openai/device/complete
 *
 * The browser receives only a flow id, user code, verification URL, and the
 * final wire-safe CredentialView. OAuth access/refresh tokens stay server-side
 * and are stored encrypted in ai_provider_credentials.
 */

import { nanoid } from 'nanoid'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { createAuditEvent } from '../../repositories/audit'
import {
  requestOpenAiDeviceAuthorization,
  pollOpenAiDeviceToken,
} from '../oauth/openai'
import {
  CredentialError,
  createCredentialForUser,
  toCredentialView,
} from '../credentials/store'
import { seedEmptyDefaults } from '../credentials/autoDefaults'

const FLOW_TTL_MS = 10 * 60 * 1_000
const FLOW_ID_BYTES = 24

interface PendingOpenAiOAuthFlow {
  userId: string
  displayLabel: string
  deviceAuthId: string
  userCode: string
  intervalMs: number
  expiresAt: number
}

const pendingFlows = new Map<string, PendingOpenAiOAuthFlow>()

const StartBodySchema = Type.Object({
  displayLabel: Type.String({ minLength: 1 }),
})

const CompleteBodySchema = Type.Object({
  flowId: Type.String({ minLength: 1 }),
})

export function tryHandleOpenAiOAuth(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname === '/admin/api/ai/oauth/openai/device/start') {
    return handleStart(req, db)
  }
  if (pathname === '/admin/api/ai/oauth/openai/device/complete') {
    return handleComplete(req, db)
  }
  return null
}

async function handleStart(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, StartBodySchema)
  if (!body) return badRequest('Invalid request body.')

  try {
    pruneExpiredFlows()
    const device = await requestOpenAiDeviceAuthorization()
    const flowId = nanoid(FLOW_ID_BYTES)
    pendingFlows.set(flowId, {
      userId: userOrResponse.id,
      displayLabel: body.displayLabel,
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      intervalMs: device.intervalMs,
      expiresAt: Date.now() + FLOW_TTL_MS,
    })
    return jsonResponse({
      flowId,
      userCode: device.userCode,
      verificationUrl: device.verificationUrl,
      intervalMs: device.intervalMs,
    })
  } catch (err) {
    console.error('[ai/openai-oauth] start failed:', getErrorMessage(err, 'Unknown error'))
    return jsonResponse({ error: 'Failed to start OpenAI OAuth.' }, { status: 502 })
  }
}

async function handleComplete(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, CompleteBodySchema)
  if (!body) return badRequest('Invalid request body.')

  pruneExpiredFlows()
  const flow = pendingFlows.get(body.flowId)
  if (!flow || flow.userId !== userOrResponse.id) {
    return jsonResponse({ error: 'OpenAI OAuth flow not found or expired.' }, { status: 404 })
  }

  try {
    const result = await pollOpenAiDeviceToken({
      deviceAuthId: flow.deviceAuthId,
      userCode: flow.userCode,
    })
    if (result.status === 'pending') {
      return jsonResponse({ status: 'pending', retryAfterMs: flow.intervalMs })
    }

    const record = await createCredentialForUser(db, userOrResponse.id, {
      providerId: 'openai',
      authMode: 'oauth',
      displayLabel: flow.displayLabel,
      oauth: result.secret,
    })
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

    try {
      await seedEmptyDefaults(db, record, userOrResponse.id)
    } catch (err) {
      console.warn(
        '[ai/openai-oauth] auto-default skipped - default seeding failed:',
        getErrorMessage(err, 'Unknown error'),
      )
    }

    pendingFlows.delete(body.flowId)
    return jsonResponse({
      status: 'success',
      credential: await toCredentialView(record),
    })
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    pendingFlows.delete(body.flowId)
    console.warn('[ai/openai-oauth] complete failed:', getErrorMessage(err, 'Unknown error'))
    return jsonResponse({
      status: 'failed',
      error: 'OpenAI OAuth failed. Please retry the authorization flow.',
    })
  }
}

function pruneExpiredFlows(): void {
  const now = Date.now()
  for (const [flowId, flow] of pendingFlows) {
    if (flow.expiresAt <= now) pendingFlows.delete(flowId)
  }
}
