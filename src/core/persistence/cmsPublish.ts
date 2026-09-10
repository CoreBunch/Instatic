import { PublicationOverviewSchema, type PublishVariantSelection } from '@core/localization-schema'
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
  selection: PublishVariantSelection = {},
): Promise<CmsPublishResult> {
  return apiRequest(`${basePath}/publish`, {
    method: 'POST',
    body: selection,
    schema: CmsPublishResultSchema,
    fetchImpl,
    fallbackMessage: 'CMS publish failed',
  })
}

export async function getCmsPublishStatus(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
  localeId?: string,
): Promise<CmsPublishStatus> {
  return apiRequest(`${basePath}/publish/status`, {
    query: { localeId },
    schema: CmsPublishStatusSchema,
    fetchImpl,
    fallbackMessage: 'CMS publish status request failed',
  })
}

export async function getCmsPublicationOverview() {
  return apiRequest('/admin/api/cms/publish/selection', {
    schema: PublicationOverviewSchema, fallbackMessage: 'Unable to load publication selection',
  })
}
