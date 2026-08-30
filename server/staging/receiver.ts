import { timingSafeEqual } from 'node:crypto'
import type { DbClient } from '../db/client'
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  payloadTooLarge,
  readValidatedBody,
  RequestBodyTooLargeError,
} from '../http'
import { applySiteBundle } from '../handlers/cms/import'
import { findActiveOwnerUserId } from '../repositories/users'
import { publishDraftSite } from '../publish/publishSite'
import {
  StagingSyncPayloadSchema,
  type StagingRefreshResult,
  type StagingSyncPayload,
} from '@core/staging'

export const STAGING_SYNC_PATH = '/_instatic/staging-sync'
const MAX_SYNC_BYTES = 64 * 1024 * 1024

export interface StagingReceiverOptions {
  environment: 'production' | 'staging'
  syncToken?: string
  uploadsDir?: string
}

export async function handleStagingSyncRequest(
  req: Request,
  db: DbClient,
  options: StagingReceiverOptions,
): Promise<Response> {
  if (options.environment !== 'staging' || !options.syncToken) {
    return jsonResponse({ error: 'Not found' }, { status: 404 })
  }
  if (!validBearerToken(req, options.syncToken)) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  }

  if (req.method === 'GET') {
    return jsonResponse({ ok: true, environment: 'staging' })
  }
  if (req.method !== 'POST') return methodNotAllowed()

  let payload: StagingSyncPayload | null
  try {
    payload = await readValidatedBody(req, StagingSyncPayloadSchema, {
      maxBytes: MAX_SYNC_BYTES,
    })
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return payloadTooLarge('Staging sync payload exceeds the 64 MiB limit.')
    }
    throw err
  }
  if (!payload) return badRequest('Invalid staging sync payload.')

  const ownerUserId = await findActiveOwnerUserId(db)
  if (!ownerUserId) {
    return jsonResponse({ error: 'The staging instance has no active owner.' }, { status: 409 })
  }

  const importResult = await applySiteBundle(
    db,
    payload.bundle,
    payload.mode === 'full' ? 'replace' : 'replace-selected',
    { uploadsDir: options.uploadsDir },
  )
  const publishResult = await publishDraftSite(db, ownerUserId, options.uploadsDir)
  const result: StagingRefreshResult = {
    ok: true,
    origin: new URL(req.url).origin,
    publishedPages: publishResult.publishedPages,
    import: importResult,
  }
  return jsonResponse(result)
}

function validBearerToken(req: Request, expected: string): boolean {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const actual = header.slice('Bearer '.length)
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
