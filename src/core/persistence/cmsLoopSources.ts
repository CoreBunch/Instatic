/**
 * Client for the plugin loop source endpoints (`server/handlers/cms/loopSources.ts`).
 */
import { Type } from '@sinclair/typebox'
import {
  LoopSourcePreviewItemsSchema,
  RemoteLoopSourceSchema,
  type LoopItem,
  type LoopSourcePreviewRequest,
  type RemoteLoopSource,
} from '@core/loops'
import { apiRequest, type FetchLike } from '@core/http'

const LoopSourcesEnvelope = Type.Object({ sources: Type.Array(RemoteLoopSourceSchema) })
const LoopSourcePreviewEnvelope = Type.Object({ items: LoopSourcePreviewItemsSchema })

/** Every loop source a running plugin has registered. */
export async function listCmsLoopSources(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<RemoteLoopSource[]> {
  const body = await apiRequest(`${basePath}/loop-sources`, {
    schema: LoopSourcesEnvelope,
    fetchImpl,
    fallbackMessage: 'Loading plugin loop sources failed',
  })
  return body.sources
}

/**
 * Sample items from a plugin source's `preview()`. Rejects with an `ApiError`:
 * 429 with `LOOP_PREVIEW_BUSY_CODE` (`@core/loops`) and `retryAfterMs` when the plugin's
 * previews are busy, 404 when nobody provides the source, 502 when the
 * preview failed.
 */
export async function previewCmsLoopSource(
  request: LoopSourcePreviewRequest,
  signal?: AbortSignal,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<LoopItem[]> {
  const body = await apiRequest(`${basePath}/loop-sources/preview`, {
    method: 'POST',
    body: request,
    signal,
    schema: LoopSourcePreviewEnvelope,
    fetchImpl,
    fallbackMessage: 'The loop source preview failed',
  })
  return body.items
}
