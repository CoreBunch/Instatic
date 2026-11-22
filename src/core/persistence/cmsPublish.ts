import { apiRequest, type FetchLike } from '@core/http'
import {
  CmsPublishResultSchema,
  CmsPublishStatusSchema,
  type CmsPublishResult,
  type CmsPublishStatus,
} from './responseSchemas'

export async function publishCmsDraft(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPublishResult> {
  return apiRequest(`${basePath}/publish`, {
    method: 'POST',
    schema: CmsPublishResultSchema,
    fetchImpl,
    fallbackMessage: 'CMS publish failed',
  })
}

interface PublishStatusRequestOptions {
  fetchImpl?: FetchLike
  basePath?: string
  signal?: AbortSignal
}

export async function getCmsPublishStatus({
  fetchImpl = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
  signal,
}: PublishStatusRequestOptions = {}): Promise<CmsPublishStatus> {
  return apiRequest(`${basePath}/publish/status`, {
    schema: CmsPublishStatusSchema,
    fetchImpl,
    signal,
    fallbackMessage: 'CMS publish status request failed',
  })
}
