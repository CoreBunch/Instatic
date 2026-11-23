/**
 * Plugin loop sources for the editor.
 *
 *   GET  /admin/api/cms/loop-sources          — every source a running plugin registered
 *   POST /admin/api/cms/loop-sources/preview  — sample items from one source's `preview()`
 *
 * Both sit on the `site.read` floor: whoever can open the editor may use a
 * plugin's source on a page, with or without rights over plugins. The
 * preview runs the plugin's `preview()` (sample data by contract) and never
 * its `fetch()`, so it cannot be used to read what a source lists for real
 * visitors. Answers are `no-store`: nothing here is shared between people.
 * A failed preview answers 502 with a general reason; what the plugin threw
 * stays in the server log. While a plugin's previews are queued up, or one
 * user asks too often, the answer is 429 with `Retry-After` and the code
 * `LOOP_PREVIEW_BUSY_CODE`, which the editor shows as busy, not as a failure.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { LOOP_PREVIEW_BUSY_CODE, LoopSourcePreviewRequestSchema } from '@core/loops'
import { listPluginLoopSources, previewPluginLoopSource } from '../../plugins/host/loopSources'
import { CMS_API_PREFIX } from './shared'
import { runRouteTable, type Route } from './routeTable'

const LOOP_SOURCES_PATH = `${CMS_API_PREFIX}/loop-sources`
const NO_STORE = { headers: { 'cache-control': 'private, no-store' } }

async function handleList(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  return jsonResponse({ sources: listPluginLoopSources() }, NO_STORE)
}

async function handlePreview(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  const body = await readValidatedBody(req, LoopSourcePreviewRequestSchema)
  if (!body) return badRequest('Invalid loop source preview request')

  const preview = await previewPluginLoopSource(user.id, body.sourceId, {
    filters: body.filters,
    limit: body.limit,
  })
  if (preview.status === 'unknown-source') {
    return jsonResponse({ error: 'No running plugin provides this loop source.' }, { status: 404 })
  }
  if (preview.status === 'busy') {
    return jsonResponse(
      { error: 'Previews of this plugin are busy. Try again in a moment.', code: LOOP_PREVIEW_BUSY_CODE },
      { status: 429, headers: { 'retry-after': String(Math.ceil(preview.retryAfterMs / 1000)) } },
    )
  }
  if (preview.status === 'failed') {
    return jsonResponse({ error: preview.error }, { status: 502 })
  }
  return jsonResponse({ items: preview.items }, NO_STORE)
}

export const LOOP_SOURCE_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: LOOP_SOURCES_PATH, handler: handleList },
  { method: 'POST', pattern: `${LOOP_SOURCES_PATH}/preview`, handler: handlePreview },
]

export function handleLoopSourceRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, LOOP_SOURCE_ROUTES)
}
