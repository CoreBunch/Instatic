/**
 * Plugin record CRUD endpoints.
 *
 *   GET    /admin/api/cms/plugins/:id/resources/:rid/records          — list
 *   POST   /admin/api/cms/plugins/:id/resources/:rid/records          — create
 *   PATCH  /admin/api/cms/plugins/:id/resources/:rid/records/:recId   — update
 *   DELETE /admin/api/cms/plugins/:id/resources/:rid/records/:recId   — delete
 *
 * "Resources" are the named, schema-bound tables a plugin's manifest can
 * declare. The dispatcher matches the URL, this handler validates the body
 * against the resource's schema and persists via the records repository.
 *
 * GET supports optional query parameters for filtering, ordering, and paging:
 *   ?filter={"fieldName":"value"}&orderBy={"fieldName":"asc"}&limit=50&offset=0
 * `filter` and `orderBy` are JSON-encoded objects. `limit` and `offset` are
 * plain integers. Unrecognised or invalid options return 400.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import {
  createPluginRecord,
  deletePluginRecord,
  listPluginRecords,
  updatePluginRecord,
} from '../../../repositories/plugins'
import { StorageListOptionsSchema } from '@core/plugin-sdk/storageSchemas'
import { Type, parseValue } from '@core/utils/typeboxHelpers'
import {
  validatePluginCspContributionRecord,
  validatePluginRecordData,
} from '@core/plugins/manifest'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  getEnabledPluginResource,
  pluginRecordNotFound,
  pluginResourceNotFound,
  recordPluginAuditEvent,
} from './shared'

function validateRecordData(
  resource: Awaited<ReturnType<typeof getEnabledPluginResource>>,
  input: unknown,
): Record<string, unknown> {
  if (!resource) throw new Error('Plugin resource not found')
  return resource.publisherCsp
    ? { ...validatePluginCspContributionRecord(input) }
    : validatePluginRecordData(resource.resource, input)
}

/**
 * Parse list options from URL search params. Returns `null` on a validation
 * failure along with a human-readable error message.
 */
function parseListOptions(url: string): { options: unknown } | { error: string } {
  let urlObj: URL
  try {
    urlObj = new URL(url, 'http://localhost')
  } catch {
    return { options: {} }
  }
  const sp = urlObj.searchParams
  const raw: Record<string, unknown> = {}

  const filterRaw = sp.get('filter')
  if (filterRaw !== null) {
    try {
      raw.filter = JSON.parse(filterRaw)
    } catch {
      return { error: 'Invalid JSON in "filter" query parameter' }
    }
  }

  const orderByRaw = sp.get('orderBy')
  if (orderByRaw !== null) {
    try {
      raw.orderBy = JSON.parse(orderByRaw)
    } catch {
      return { error: 'Invalid JSON in "orderBy" query parameter' }
    }
  }

  const limitRaw = sp.get('limit')
  if (limitRaw !== null) {
    const n = Number(limitRaw)
    if (!Number.isInteger(n)) return { error: '"limit" must be an integer' }
    raw.limit = n
  }

  const offsetRaw = sp.get('offset')
  if (offsetRaw !== null) {
    const n = Number(offsetRaw)
    if (!Number.isInteger(n)) return { error: '"offset" must be an integer' }
    raw.offset = n
  }

  return { options: raw }
}

export async function handlePluginRecordsCollection(
  req: Request,
  db: DbClient,
  user: AuthUser,
  pluginId: string,
  resourceId: string,
): Promise<Response> {
  const resource = await getEnabledPluginResource(db, pluginId, resourceId)
  if (!resource) return pluginResourceNotFound()

  if (req.method === 'GET') {
    const parsed = parseListOptions(req.url)
    if ('error' in parsed) return badRequest(parsed.error)

    let options
    try {
      options = parseValue(StorageListOptionsSchema, parsed.options)
    } catch {
      return badRequest('Invalid list options: filter, orderBy, limit, and offset must match the expected types')
    }

    const { records, totalCount } = await listPluginRecords(db, pluginId, resourceId, options)
    return jsonResponse({ resource: resource.resource, records, totalCount })
  }

  if (req.method === 'POST') {
    const PluginRecordBodySchema = Type.Object({ data: Type.Optional(Type.Unknown()) })
    const body = await readValidatedBody(req, PluginRecordBodySchema)
    if (!body) return badRequest('Invalid request body')
    try {
      const data = validateRecordData(resource, body.data ?? body)
      const record = await createPluginRecord(db, {
        id: nanoid(),
        pluginId,
        resourceId,
        data,
      })
      await recordPluginAuditEvent(db, user, req, 'plugin.resource.create', pluginId, {
        resourceId,
        recordId: record.id,
      })
      return jsonResponse({ record }, { status: 201 })
    } catch (err) {
      return badRequest(getErrorMessage(err, 'Invalid plugin record data'))
    }
  }

  return methodNotAllowed()
}

export async function handlePluginRecordItem(
  req: Request,
  db: DbClient,
  user: AuthUser,
  pluginId: string,
  resourceId: string,
  recordId: string,
): Promise<Response> {
  const resource = await getEnabledPluginResource(db, pluginId, resourceId)
  if (!resource) return pluginResourceNotFound()

  if (req.method === 'PATCH') {
    const PluginRecordPatchBodySchema = Type.Object({ data: Type.Optional(Type.Unknown()) })
    const body = await readValidatedBody(req, PluginRecordPatchBodySchema)
    if (!body) return badRequest('Invalid request body')
    try {
      const data = validateRecordData(resource, body.data ?? body)
      const record = await updatePluginRecord(db, {
        id: recordId,
        pluginId,
        resourceId,
        data,
      })
      if (!record) return pluginRecordNotFound()
      await recordPluginAuditEvent(db, user, req, 'plugin.resource.update', pluginId, {
        resourceId,
        recordId,
      })
      return jsonResponse({ record })
    } catch (err) {
      return badRequest(getErrorMessage(err, 'Invalid plugin record data'))
    }
  }

  if (req.method === 'DELETE') {
    const deleted = await deletePluginRecord(db, {
      id: recordId,
      pluginId,
      resourceId,
    })
    if (!deleted) return pluginRecordNotFound()
    await recordPluginAuditEvent(db, user, req, 'plugin.resource.delete', pluginId, {
      resourceId,
      recordId,
    })
    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}
