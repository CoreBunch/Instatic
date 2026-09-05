/**
 * Client for the server-side npm registry proxy (`server/handlers/cms/registry.ts`).
 * Every response is validated against the shared `@core/registry` schemas.
 */
import { apiRequest, type FetchLike } from '@core/http'
import {
  RegistryAdvisoriesSchema,
  RegistryDownloadsSchema,
  RegistryLatestVersionSchema,
  RegistryPackageDetailsSchema,
  RegistryProfileSchema,
  RegistrySearchPageSchema,
  type RegistryAdvisories,
  type RegistryDownloads,
  type RegistryLatestVersion,
  type RegistryPackageDetails,
  type RegistryProfile,
  type RegistrySearchPage,
  type RegistrySearchSort,
} from '@core/registry'

interface CmsRegistryRequestOptions {
  signal?: AbortSignal
  /** Injectable fetch — test seam only; defaults to the global `fetch`. */
  fetchImpl?: FetchLike
  basePath?: string
}

interface CmsRegistrySearchParams {
  text: string
  sort?: RegistrySearchSort
  from?: number
  size?: number
  /** Default (server-side) is to hide deprecated packages; exact-name lookups pass `false`. */
  hideDeprecated?: boolean
}

function packagePath(basePath: string, name: string): string {
  return `${basePath}/registry/packages/${encodeURIComponent(name)}`
}

export function getCmsRegistryProfile(options: CmsRegistryRequestOptions = {}): Promise<RegistryProfile> {
  const { signal, fetchImpl, basePath = '/admin/api/cms' } = options
  return apiRequest(`${basePath}/registry`, {
    schema: RegistryProfileSchema,
    signal,
    fetchImpl,
    fallbackMessage: 'Could not read the registry configuration',
  })
}

export function searchCmsRegistry(
  params: CmsRegistrySearchParams,
  options: CmsRegistryRequestOptions = {},
): Promise<RegistrySearchPage> {
  const { signal, fetchImpl, basePath = '/admin/api/cms' } = options
  return apiRequest(`${basePath}/registry/search`, {
    query: {
      q: params.text,
      sort: params.sort,
      from: params.from,
      size: params.size,
      deprecated: params.hideDeprecated === undefined ? undefined : params.hideDeprecated ? 'hide' : 'show',
    },
    schema: RegistrySearchPageSchema,
    signal,
    fetchImpl,
    fallbackMessage: 'Registry search failed',
  })
}

export function getCmsRegistryPackage(
  name: string,
  options: CmsRegistryRequestOptions = {},
): Promise<RegistryPackageDetails> {
  const { signal, fetchImpl, basePath = '/admin/api/cms' } = options
  return apiRequest(packagePath(basePath, name), {
    schema: RegistryPackageDetailsSchema,
    signal,
    fetchImpl,
    fallbackMessage: 'Could not load the package',
  })
}

export function getCmsRegistryLatestVersion(
  name: string,
  options: CmsRegistryRequestOptions = {},
): Promise<RegistryLatestVersion> {
  const { signal, fetchImpl, basePath = '/admin/api/cms' } = options
  return apiRequest(`${packagePath(basePath, name)}/latest`, {
    schema: RegistryLatestVersionSchema,
    signal,
    fetchImpl,
    fallbackMessage: 'Could not check the latest version',
  })
}

export function getCmsRegistryPackageDownloads(
  name: string,
  options: CmsRegistryRequestOptions = {},
): Promise<RegistryDownloads> {
  const { signal, fetchImpl, basePath = '/admin/api/cms' } = options
  return apiRequest(`${packagePath(basePath, name)}/downloads`, {
    schema: RegistryDownloadsSchema,
    signal,
    fetchImpl,
    fallbackMessage: 'Could not load download statistics',
  })
}

export function getCmsRegistryPackageAdvisories(
  name: string,
  version: string,
  options: CmsRegistryRequestOptions = {},
): Promise<RegistryAdvisories> {
  const { signal, fetchImpl, basePath = '/admin/api/cms' } = options
  return apiRequest(`${packagePath(basePath, name)}/advisories`, {
    query: { version },
    schema: RegistryAdvisoriesSchema,
    signal,
    fetchImpl,
    fallbackMessage: 'Could not load security advisories',
  })
}
