/**
 * npm registry proxy for the Dependencies panel.
 *
 *   GET /admin/api/cms/registry                             — registry profile (host, public npm or not)
 *   GET /admin/api/cms/registry/search?q=&sort=&from=&size=&deprecated=hide|show
 *   GET /admin/api/cms/registry/packages/:name             — details (README, versions, links)
 *   GET /admin/api/cms/registry/packages/:name/latest      — latest version only (update checks)
 *   GET /admin/api/cms/registry/packages/:name/downloads   — 30-day daily downloads
 *   GET /admin/api/cms/registry/packages/:name/advisories?version=
 *
 * Browsing is read-only, so every route sits on the `site.read` floor;
 * installing still goes through the capability-gated resolve endpoint. The
 * registry host comes from server config only — nothing in a request can
 * redirect these reads — and package names are validated before they touch a
 * URL. The request's own signal is forwarded upstream, so a panel that moves
 * on stops paying for the read. Responses carry `Cache-Control: private` with
 * the server cache's own window, so the browser cache backs the TTL cache.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { badRequest, jsonResponse } from '../../http'
import { Type, parseValue } from '@core/utils/typeboxHelpers'
import {
  REGISTRY_MAX_SEARCH_FROM,
  REGISTRY_SEARCH_PAGE_SIZE,
  RegistrySearchSortSchema,
} from '@core/registry'
import { isSafePackageName, isSafePackageVersion } from '@core/site-dependencies/packageNames'
import {
  RegistryUpstreamError,
  TTL,
  getAdvisories,
  getDownloads,
  getLatestVersion,
  getPackageDetails,
  searchPackages,
} from '../../registry/client'
import { registryProfile } from '../../registry/config'
import { CMS_API_PREFIX } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'

const REGISTRY_PREFIX = `${CMS_API_PREFIX}/registry`

const SearchQuerySchema = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 200 }),
  sort: RegistrySearchSortSchema,
  from: Type.Integer({ minimum: 0, maximum: REGISTRY_MAX_SEARCH_FROM }),
  size: Type.Integer({ minimum: 1, maximum: 50 }),
  deprecated: Type.Union([Type.Literal('hide'), Type.Literal('show')]),
})

function upstreamErrorResponse(err: unknown): Response {
  if (err instanceof RegistryUpstreamError) {
    if (err.status === 404) return jsonResponse({ error: 'Package not found' }, { status: 404 })
    return jsonResponse({ error: err.message }, { status: err.kind === 'timeout' ? 504 : 502 })
  }
  console.error('[registry]', err)
  return jsonResponse({ error: 'Registry request failed' }, { status: 502 })
}

/**
 * Every registry route shares one shape: the `site.read` gate, the upstream
 * error mapping, and a `Cache-Control` window taken from the server cache's
 * own TTL. `load` returns the body, or a `Response` when it wants to reject
 * the request itself.
 */
function registryRoute(
  ttlMs: number,
  load: (req: Request, url: URL, params: RouteParams) => Promise<unknown> | Response,
) {
  return async (req: Request, db: DbClient, params: RouteParams): Promise<Response> => {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user
    try {
      const result = load(req, new URL(req.url), params)
      if (result instanceof Response) return result
      return jsonResponse(await result, {
        headers: { 'cache-control': `private, max-age=${Math.floor(ttlMs / 1000)}` },
      })
    } catch (err) {
      return upstreamErrorResponse(err)
    }
  }
}

/** The four per-package routes additionally validate the name before it reaches a URL. */
function packageRoute(ttlMs: number, load: (name: string, req: Request, url: URL) => Promise<unknown> | Response) {
  return registryRoute(ttlMs, (req, url, params) => {
    const name = params.name?.trim() ?? ''
    if (!isSafePackageName(name)) return badRequest('Invalid package name')
    return load(name, req, url)
  })
}

function handleSearch(req: Request, url: URL): Promise<unknown> | Response {
  let query
  try {
    query = parseValue(SearchQuerySchema, {
      q: url.searchParams.get('q') ?? '',
      sort: url.searchParams.get('sort') ?? 'relevance',
      from: Number(url.searchParams.get('from') ?? '0'),
      size: Number(url.searchParams.get('size') ?? String(REGISTRY_SEARCH_PAGE_SIZE)),
      deprecated: url.searchParams.get('deprecated') ?? 'hide',
    })
  } catch {
    return badRequest('Invalid registry search query')
  }
  return searchPackages(
    {
      text: query.q,
      sort: query.sort,
      from: query.from,
      size: query.size,
      hideDeprecated: query.deprecated === 'hide',
    },
    { signal: req.signal },
  )
}

// Package names arrive URL-encoded (`@scope%2Fname`); the dispatcher decodes
// the capture once, so handlers see `@scope/name` and validate that.
const NAME = '(?<name>[^/]+)'

const REGISTRY_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: REGISTRY_PREFIX, handler: registryRoute(TTL.details, () => Promise.resolve(registryProfile())) },
  { method: 'GET', pattern: `${REGISTRY_PREFIX}/search`, handler: registryRoute(TTL.search, handleSearch) },
  {
    method: 'GET',
    pattern: new RegExp(`^${REGISTRY_PREFIX}/packages/${NAME}$`),
    handler: packageRoute(TTL.details, (name, req) => getPackageDetails(name, { signal: req.signal })),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${REGISTRY_PREFIX}/packages/${NAME}/latest$`),
    handler: packageRoute(TTL.details, (name, req) => getLatestVersion(name, { signal: req.signal })),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${REGISTRY_PREFIX}/packages/${NAME}/downloads$`),
    handler: packageRoute(TTL.downloads, (name, req) => getDownloads(name, { signal: req.signal })),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^${REGISTRY_PREFIX}/packages/${NAME}/advisories$`),
    handler: packageRoute(TTL.advisories, (name, req, url) => {
      const version = url.searchParams.get('version')?.trim() ?? ''
      if (!isSafePackageVersion(version)) return badRequest('Invalid package version')
      return getAdvisories(name, version, { signal: req.signal })
    }),
  },
]

export function handleRegistryRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, REGISTRY_ROUTES)
}
