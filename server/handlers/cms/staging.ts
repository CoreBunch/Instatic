import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { listDataTables } from '../../repositories/data/tables'
import { createAuditEvent } from '../../repositories/audit'
import {
  deleteStagingEnvironment,
  getStagingEnvironment,
  recordStagingSync,
  resolveStagingEnvironment,
  saveStagingEnvironment,
  StagingEnvironmentError,
} from '../../repositories/stagingEnvironment'
import { buildStagingBundle } from '../../staging/bundle'
import { STAGING_SYNC_PATH } from '../../staging/receiver'
import { getErrorMessage } from '@core/utils/errorMessage'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { responseErrorMessage } from '@core/http'
import {
  SaveStagingEnvironmentSchema,
  StagingReceiverStatusSchema,
  StagingRefreshResultSchema,
} from '@core/staging'
import { CMS_API_PREFIX, requestAuditContext } from './shared'

const STAGING_PATH = `${CMS_API_PREFIX}/staging`
const STAGING_TEST_PATH = `${STAGING_PATH}/test`
const STAGING_REFRESH_PATH = `${STAGING_PATH}/refresh`

export async function handleStagingRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  if (![STAGING_PATH, STAGING_TEST_PATH, STAGING_REFRESH_PATH].includes(pathname)) return null

  const user = await requireCapability(req, db, 'deployment.manage')
  if (user instanceof Response) return user

  try {
    if (pathname === STAGING_PATH && req.method === 'GET') {
      return jsonResponse(await getStagingEnvironment(db))
    }

    if (pathname === STAGING_PATH && req.method === 'PUT') {
      const stepUp = await requireStepUp(req, db, user)
      if (stepUp) return stepUp
      const body = await readValidatedBody(req, SaveStagingEnvironmentSchema)
      if (!body) return badRequest('Invalid staging configuration.')

      const origin = normalizeStagingOrigin(body.origin)
      if (!origin) {
        return badRequest('Use an HTTPS origin without a path, query, fragment, or embedded credentials.')
      }
      const knownTableIds = new Set((await listDataTables(db)).map((table) => table.id))
      const unknownTableId = body.tableIds.find((id) => !knownTableIds.has(id))
      if (unknownTableId) return badRequest(`Unknown data table: ${unknownTableId}`)

      const environment = await saveStagingEnvironment(db, { ...body, origin }, user.id)
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'staging.configured',
        targetType: 'deployment_environment',
        targetId: 'staging',
        metadata: { origin, tableCount: body.tableIds.length, includeSite: body.includeSite },
        ...requestAuditContext(req),
      })
      return jsonResponse(environment)
    }

    if (pathname === STAGING_PATH && req.method === 'DELETE') {
      const stepUp = await requireStepUp(req, db, user)
      if (stepUp) return stepUp
      const deleted = await deleteStagingEnvironment(db)
      if (!deleted) return jsonResponse({ error: 'Staging is not configured.' }, { status: 404 })
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'staging.removed',
        targetType: 'deployment_environment',
        targetId: 'staging',
        ...requestAuditContext(req),
      })
      return jsonResponse({ ok: true })
    }

    if (pathname === STAGING_TEST_PATH && req.method === 'POST') {
      const target = await resolveStagingEnvironment(db)
      await testTarget(target.origin, target.token)
      return jsonResponse({ ok: true, origin: target.origin })
    }

    if (pathname === STAGING_REFRESH_PATH && req.method === 'POST') {
      const stepUp = await requireStepUp(req, db, user)
      if (stepUp) return stepUp
      const target = await resolveStagingEnvironment(db)
      try {
        const bundle = await buildStagingBundle(db, target)
        const response = await fetch(`${target.origin}${STAGING_SYNC_PATH}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${target.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            mode: target.tableIds.length === 0 ? 'full' : 'selected',
            bundle,
          }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) {
          throw new StagingEnvironmentError(
            await responseErrorMessage(response, `Staging refresh failed with HTTP ${response.status}.`),
            response.status,
          )
        }
        const result = await parseJsonResponse(response, StagingRefreshResultSchema)
        await recordStagingSync(db, 'success', null)
        await createAuditEvent(db, {
          actorUserId: user.id,
          action: 'staging.refreshed',
          targetType: 'deployment_environment',
          targetId: 'staging',
          metadata: {
            origin: target.origin,
            mode: target.tableIds.length === 0 ? 'full' : 'selected',
            tableCount: result.import.tablesAffected,
            rowCount: result.import.rowsInserted,
            publishedPages: result.publishedPages,
          },
          ...requestAuditContext(req),
        })
        return jsonResponse({ ...result, origin: target.origin })
      } catch (err) {
        const message = getErrorMessage(err, 'Staging refresh failed.')
        await recordStagingSync(db, 'failed', message.slice(0, 1000))
        throw err
      }
    }

    return methodNotAllowed()
  } catch (err) {
    if (err instanceof StagingEnvironmentError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    console.error('[staging] request failed:', err)
    return jsonResponse({ error: 'Staging operation failed.' }, { status: 502 })
  }
}

async function testTarget(origin: string, token: string): Promise<void> {
  const response = await fetch(`${origin}${STAGING_SYNC_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new StagingEnvironmentError(
      await responseErrorMessage(response, `Connection test failed with HTTP ${response.status}.`),
      response.status,
    )
  }
  await parseJsonResponse(response, StagingReceiverStatusSchema)
}

export function normalizeStagingOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    const localDevelopment = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
    if (url.protocol !== 'https:' && !localDevelopment) return null
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}
