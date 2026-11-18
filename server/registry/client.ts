/**
 * Server-side npm registry client — the only code that talks to the
 * registry, npm's downloads API and OSV.
 *
 *   searchPackages       GET  <registry>/-/v1/search            (cached 5 min)
 *   getInstallPackument  GET  <registry>/<name>                  (abbreviated, always fresh: the resolver installs from it)
 *   getPackageDetails    packument → RegistryPackageDetails      (cached 10 min, projection only)
 *   getLatestVersion     GET  <registry>/<name>/latest            (one version manifest, cached 10 min)
 *   getDownloads         GET  api.npmjs.org/downloads/range/last-month/<name>   (public npm only)
 *   getAdvisories        POST api.osv.dev/v1/query               (public npm only)
 *
 * Cached reads go through a bounded TTL cache with single-flight loading, so
 * search-as-you-type and repeated package opens cost one upstream request per
 * TTL window. Only projections are cached, never raw packuments: a popular
 * packument is tens of megabytes of JSON, a projection a few tens of kB.
 * Upstream failures surface as `RegistryUpstreamError` so the handler can map
 * them to 502 / 504 / 404 without inspecting messages.
 *
 * `deps.fetchImpl` is the unit-test seam: when a caller injects fetch, no
 * cache is read from or written to, so a test never observes another test's
 * data. `setRegistryFetchForTests` swaps the transport for handler tests while
 * keeping the caches live (and clears them on every swap).
 */
import { coerce as coerceVersion, rcompare } from 'semver'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { Type, filterArray, filterRecord, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { isRecord } from '@core/utils/isRecord'
import { stripTrailingSlashes } from '@core/utils/urlValidation'
import { isSafePackageName, isSafePackageVersion } from '@core/site-dependencies/packageNames'
import {
  cleanPackageDescription,
  pickEsmEntry,
  type RegistryAdvisories,
  type RegistryAdvisory,
  type RegistryDownloads,
  type RegistryLatestVersion,
  type RegistryPackageDetails,
  type RegistrySearchHit,
  type RegistrySearchPage,
  type RegistrySearchSort,
  type RegistryVersionInfo,
} from '@core/registry'
import { TtlCache } from './cache'
import { NPM_DOWNLOADS_API_URL, OSV_API_URL, isPublicNpmRegistry, npmRegistryUrl } from './config'
import {
  DownloadsRangeResponseSchema,
  OsvQueryResponseSchema,
  PackumentSchema,
  SearchResponseSchema,
  VersionManifestSchema,
  type Packument,
  type PackumentVersion,
} from './upstream'

type RegistryUpstreamErrorKind = 'timeout' | 'status' | 'network' | 'shape' | 'too-large'

export class RegistryUpstreamError extends Error {
  readonly kind: RegistryUpstreamErrorKind
  readonly status: number | undefined

  constructor(kind: RegistryUpstreamErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'RegistryUpstreamError'
    this.kind = kind
    this.status = status
  }
}

interface RegistryClientDeps {
  /** Injectable fetch — unit-test seam. Bypasses the shared caches. */
  fetchImpl?: typeof fetch
  /** Registry base URL; defaults to the configured `NPM_REGISTRY_URL`. */
  registryUrl?: string
  /**
   * The caller's request signal. Only honoured for uncached reads: a cached
   * load is shared by every caller on that key, so letting the first one
   * cancel it would fail the others.
   */
  signal?: AbortSignal
  /** Overrides the per-operation budget. Tests use it to force a timeout. */
  timeoutMs?: number
}

interface RegistrySearchParams {
  text: string
  sort: RegistrySearchSort
  from: number
  size: number
  hideDeprecated: boolean
}

const MINUTE = 60_000
/** Server-side cache windows; the handler derives its `Cache-Control` max-age from the same table. */
export const TTL = {
  search: 5 * MINUTE,
  details: 10 * MINUTE,
  downloads: 6 * 60 * MINUTE,
  advisories: 60 * MINUTE,
} as const

/**
 * Budgets, all covering the whole exchange including the body read: a stalled
 * body must not pin a single-flight key. Search and stats are small; a full
 * packument is megabytes, so browsing a big package gets longer, and an
 * install gets what `bun install` gets.
 */
const TIMEOUT_MS = { small: 10_000, packument: 30_000, install: 60_000 } as const
/**
 * Refuse absurd documents rather than parsing them: `aws-sdk`'s packument
 * alone is ~90 MB. Counted over the decoded body, because a `content-length`
 * header reports the compressed size and chunked responses carry none.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
/** READMEs are rendered into a clamped panel; caching megabytes of prose per package is not worth it. */
const MAX_README_BYTES = 256 * 1024
/** Newest versions returned in package details; dist-tagged versions are always kept and the full count travels alongside. */
const MAX_DETAIL_VERSIONS = 100

const FULL_PACKUMENT_ACCEPT = 'application/json'
/** npm's own accept string: the corgi document when the registry has it, the full one otherwise. */
const ABBREVIATED_PACKUMENT_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8'

const NonEmptyString = Type.String({ minLength: 1 })
const AnyString = Type.String()

const searchCache = new TtlCache<RegistrySearchPage>(500, TTL.search)
const detailsCache = new TtlCache<RegistryPackageDetails>(300, TTL.details)
const latestCache = new TtlCache<RegistryLatestVersion>(1000, TTL.details)
const downloadsCache = new TtlCache<RegistryDownloads>(500, TTL.downloads)
const advisoriesCache = new TtlCache<RegistryAdvisories>(1000, TTL.advisories)

let testFetchOverride: typeof fetch | null = null

/** Route every upstream request through `fetchImpl` (null restores the real fetch) and clear the caches. Tests only. */
export function setRegistryFetchForTests(fetchImpl: typeof fetch | null): void {
  testFetchOverride = fetchImpl
  for (const cache of [searchCache, detailsCache, latestCache, downloadsCache, advisoriesCache]) cache.clear()
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function encodePackageName(name: string): string {
  // Scoped names keep their leading `@` literal (npm wants `@scope%2Fname`);
  // every `/` is encoded, not just the first (CodeQL js/incomplete-sanitization).
  return name.startsWith('@') ? name.replaceAll('/', '%2F') : encodeURIComponent(name)
}

function resolveRegistryUrl(deps: RegistryClientDeps): string {
  return stripTrailingSlashes(deps.registryUrl ?? npmRegistryUrl())
}

function packageUrl(deps: RegistryClientDeps, name: string): string {
  return `${resolveRegistryUrl(deps)}/${encodePackageName(name)}`
}

function assertSafeName(name: string): string {
  const trimmed = name.trim()
  if (!isSafePackageName(trimmed)) {
    throw new Error(`[registry] Invalid package name "${name}"`)
  }
  return trimmed
}

interface FetchOptions extends RequestInit {
  timeoutMs?: number
  /** Returned instead of throwing when the upstream answers 404. */
  notFound?: unknown
}

/**
 * Read a response body, refusing anything past `MAX_RESPONSE_BYTES`. The count
 * is over the bytes actually delivered, so compression and chunked encoding
 * cannot hide the real size from it.
 */
async function cappedResponse(res: Response): Promise<Response> {
  if (!res.body) return res
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new RegistryUpstreamError('too-large', `Registry document exceeds ${MAX_RESPONSE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return new Response(new Blob(chunks as BlobPart[]), { headers: res.headers })
}

/**
 * Fetch and validate one upstream JSON document. One timeout covers connect,
 * headers and the body read, and the caller's own signal aborts it too, so an
 * abandoned browse stops costing upstream bandwidth.
 */
async function fetchJson<S extends TSchema>(
  url: string,
  schema: S,
  deps: RegistryClientDeps,
  { timeoutMs: operationTimeout = TIMEOUT_MS.small, notFound, ...init }: FetchOptions = {},
): Promise<Static<S>> {
  const fetchImpl = deps.fetchImpl ?? testFetchOverride ?? fetch
  const timeoutMs = deps.timeoutMs ?? operationTimeout
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout.signal]) : timeout.signal
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal,
      headers: { accept: FULL_PACKUMENT_ACCEPT, ...(init.headers ?? {}) },
    })
    if (res.status === 404) {
      if (notFound !== undefined) return notFound as Static<S>
      throw new RegistryUpstreamError('status', 'Package not found', 404)
    }
    if (!res.ok) throw new RegistryUpstreamError('status', `Registry responded with ${res.status}`, res.status)
    try {
      return await parseJsonResponse(await cappedResponse(res), schema)
    } catch (err) {
      if (err instanceof RegistryUpstreamError) throw err
      if (timeout.signal.aborted || deps.signal?.aborted) throw err
      throw new RegistryUpstreamError('shape', `Unexpected registry response: ${getErrorMessage(err, 'invalid JSON')}`)
    }
  } catch (err) {
    if (err instanceof RegistryUpstreamError) throw err
    if (timeout.signal.aborted) {
      throw new RegistryUpstreamError('timeout', `Registry request timed out after ${timeoutMs} ms`)
    }
    throw new RegistryUpstreamError('network', `Registry request failed: ${getErrorMessage(err, 'network error')}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Injected-fetch callers bypass the shared caches entirely, reads and writes alike. */
function usesSharedCaches(deps: RegistryClientDeps): boolean {
  return deps.fetchImpl === undefined
}

/**
 * Run `loader` through the cache, single-flighting concurrent misses.
 *
 * The loader is built from `deps` with the caller's signal dropped: several
 * requests share one in-flight promise, so honouring one caller's abort would
 * reject the others with a 502. The upstream read keeps its own timeout, and a
 * load nobody is waiting for any more still fills the cache, so the work is
 * not wasted even when its requester has gone.
 */
function cached<T>(
  cache: TtlCache<T>,
  key: string,
  deps: RegistryClientDeps,
  loader: (shared: RegistryClientDeps) => Promise<T>,
): Promise<T> {
  if (!usesSharedCaches(deps)) return loader(deps)
  const { signal: _callerSignal, ...shared } = deps
  return cache.getOrLoad(key, () => loader(shared))
}

// ---------------------------------------------------------------------------
// Value helpers for the loose upstream shapes
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** `license` is a string in most manifests and `{ type, url }` in older ones. */
function licenseString(value: unknown): string | null {
  if (typeof value === 'string') return asString(value)
  if (isRecord(value)) return asString(value.type)
  return null
}

/** `repository` is `{ type, url }` or a bare string, in git+https, git://, ssh:// or git@ spellings. */
function repositoryUrl(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : isRecord(value) ? asString(value.url) : null
  if (!raw) return null
  const normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
  return /^https?:\/\//.test(normalized) ? normalized : null
}

function httpUrl(value: unknown): string | null {
  const raw = asString(value)
  return raw && /^https?:\/\//.test(raw) ? raw : null
}

function maintainerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const name = isRecord(entry) ? asString(entry.name) : null
    return name ? [name] : []
  })
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

type SearchObject = NonNullable<Static<typeof SearchResponseSchema>['objects']>[number]

function mapSearchHit(raw: SearchObject): RegistrySearchHit | null {
  const pkg = raw.package
  const name = asString(pkg?.name)
  // Names the site runtime cannot declare (legacy uppercase, odd characters)
  // are not offered at all: a tile that cannot be installed is noise.
  if (!name || !isSafePackageName(name)) return null
  const detail = raw.score?.detail
  return {
    name,
    version: pkg?.version ?? '',
    description: cleanPackageDescription(pkg?.description ?? ''),
    publisher: asString(pkg?.publisher?.username),
    date: asString(pkg?.date),
    weeklyDownloads: raw.downloads?.weekly ?? 0,
    dependents: Number(raw.dependents ?? 0) || 0,
    score: {
      quality: detail?.quality ?? 0,
      popularity: detail?.popularity ?? 0,
      maintenance: detail?.maintenance ?? 0,
    },
    insecure: (raw.flags?.insecure ?? 0) > 0,
  }
}

export async function searchPackages(params: RegistrySearchParams, deps: RegistryClientDeps = {}): Promise<RegistrySearchPage> {
  const registryUrl = resolveRegistryUrl(deps)
  // `not:deprecated` is npm's search-index syntax; a private registry would
  // match it as literal text and answer with nothing.
  const text = params.hideDeprecated && isPublicNpmRegistry(registryUrl)
    ? `${params.text.trim()} not:deprecated`
    : params.text.trim()
  const query = new URLSearchParams({ text, size: String(params.size), from: String(params.from) })
  if (params.sort !== 'relevance') {
    query.set('quality', '0')
    query.set('popularity', params.sort === 'popularity' ? '1' : '0')
    query.set('maintenance', params.sort === 'maintenance' ? '1' : '0')
  }
  const url = `${registryUrl}/-/v1/search?${query.toString()}`
  return cached(searchCache, url, deps, async (shared) => {
    // A registry without a search endpoint is not an error: the panel still
    // opens packages by exact name.
    const body = await fetchJson(url, SearchResponseSchema, shared, { notFound: {} })
    const objects = body.objects ?? []
    const hits = objects.flatMap((entry) => {
      const hit = mapSearchHit(entry)
      return hit ? [hit] : []
    })
    return { total: body.total ?? hits.length, returned: objects.length, hits }
  })
}

// ---------------------------------------------------------------------------
// Packument + details
// ---------------------------------------------------------------------------

/**
 * The abbreviated install document (`dist-tags`, `versions` with `dist`, no
 * README or `time`), fetched fresh every time. The dependency resolver
 * installs from it, so it must see a version the moment it is published;
 * browsing reads go through `getPackageDetails`, which caches the projection.
 * Registries without the corgi document answer with the full one.
 */
export async function getInstallPackument(name: string, deps: RegistryClientDeps = {}): Promise<Packument> {
  const safeName = assertSafeName(name)
  return fetchJson(packageUrl(deps, safeName), PackumentSchema, deps, {
    headers: { accept: ABBREVIATED_PACKUMENT_ACCEPT },
    timeoutMs: TIMEOUT_MS.install,
  })
}

function mapVersion(version: string, raw: PackumentVersion, time: Record<string, string>): RegistryVersionInfo {
  return {
    version,
    date: time[version] ?? null,
    deprecated: asString(raw.deprecated),
    license: licenseString(raw.license),
    dependencies: filterRecord(NonEmptyString, raw.dependencies),
    peerDependencies: filterRecord(NonEmptyString, raw.peerDependencies),
    unpackedSize: raw.dist?.unpackedSize ?? null,
    fileCount: raw.dist?.fileCount ?? null,
    esmEntry: pickEsmEntry(raw),
    hasTypes: typeof raw.types === 'string' || typeof raw.typings === 'string',
  }
}

/**
 * Newest first. ISO-8601 timestamps sort as strings, so publish dates order
 * directly; where the packument carries no `time` (abbreviated documents, some
 * private registries) the versions themselves are compared instead, since
 * registry key order is oldest-first and would invert the whole list.
 */
function byNewest(a: string, b: string, time: Record<string, string>): number {
  const left = time[a] ?? ''
  const right = time[b] ?? ''
  if (left && right && left !== right) return left > right ? -1 : 1
  return rcompare(coerceVersion(a) ?? '0.0.0', coerceVersion(b) ?? '0.0.0')
}

export function packageDetailsFromPackument(name: string, packument: Packument): RegistryPackageDetails {
  const time = filterRecord(AnyString, packument.time)
  const versions = packument.versions ?? {}
  // A dist-tag can outlive the version it names (an unpublish); offering it as
  // an install choice would write a range nothing satisfies.
  const distTags = Object.fromEntries(
    Object.entries(packument['dist-tags'] ?? {}).filter(([, version]) => Object.hasOwn(versions, version)),
  )
  const versionNames = Object.keys(versions).sort((a, b) => byNewest(a, b, time))
  // Newest N plus every dist-tagged version: a package with a stream of
  // canary releases must still carry its `latest` in the list the panel
  // reads license, size, badges and dependencies from. Only the kept
  // versions are projected; a big package has thousands.
  const keep = new Set(versionNames.slice(0, MAX_DETAIL_VERSIONS))
  for (const tagged of Object.values(distTags)) keep.add(tagged)
  const kept = versionNames
    .filter((version) => keep.has(version))
    .map((version) => mapVersion(version, versions[version], time))
  const latest = distTags.latest ?? versionNames[0] ?? ''
  const latestInfo = kept.find((info) => info.version === latest)
  const readme = typeof packument.readme === 'string' ? packument.readme : ''
  return {
    name: packument.name ?? name,
    description: cleanPackageDescription(asString(packument.description) ?? ''),
    latest,
    distTags,
    versions: kept,
    versionCount: versionNames.length,
    readme: readme.length > MAX_README_BYTES ? readme.slice(0, MAX_README_BYTES) : readme,
    homepage: httpUrl(packument.homepage),
    repository: repositoryUrl(packument.repository),
    license: latestInfo?.license ?? licenseString(packument.license),
    maintainers: maintainerNames(packument.maintainers),
    keywords: filterArray(NonEmptyString, packument.keywords),
    modified: asString(time.modified),
  }
}

export async function getPackageDetails(name: string, deps: RegistryClientDeps = {}): Promise<RegistryPackageDetails> {
  const safeName = assertSafeName(name)
  const url = packageUrl(deps, safeName)
  return cached(detailsCache, url, deps, async (shared) => {
    const packument = await fetchJson(url, PackumentSchema, shared, { timeoutMs: TIMEOUT_MS.packument })
    const details = packageDetailsFromPackument(safeName, packument)
    // The package page and the home row agree on "latest" without a second
    // request — but never seed a shared cache from an injected transport.
    if (usesSharedCaches(deps)) latestCache.set(`${url}/latest`, { version: details.latest || null })
    return details
  })
}

/** The `latest` dist-tag from one version manifest: a few kB, where the packument would be megabytes. */
export async function getLatestVersion(name: string, deps: RegistryClientDeps = {}): Promise<RegistryLatestVersion> {
  const safeName = assertSafeName(name)
  const url = `${packageUrl(deps, safeName)}/latest`
  return cached(latestCache, url, deps, async (shared) => {
    const manifest = await fetchJson(url, VersionManifestSchema, shared, { notFound: {} })
    return { version: asString(manifest.version) }
  })
}

// ---------------------------------------------------------------------------
// Downloads + advisories (public npm / OSV APIs)
// ---------------------------------------------------------------------------

const NO_DOWNLOADS: RegistryDownloads = { daily: [], weekly: null }
const NO_ADVISORIES: RegistryAdvisories = { advisories: [] }

/** Stats and advisories describe the public registry; a private mirror's package names never leave the server. */
function publicStatsAvailable(deps: RegistryClientDeps): boolean {
  return isPublicNpmRegistry(resolveRegistryUrl(deps))
}

export async function getDownloads(name: string, deps: RegistryClientDeps = {}): Promise<RegistryDownloads> {
  const safeName = assertSafeName(name)
  if (!publicStatsAvailable(deps)) return NO_DOWNLOADS
  const url = `${NPM_DOWNLOADS_API_URL}/downloads/range/last-month/${encodePackageName(safeName)}`
  return cached(downloadsCache, url, deps, async (shared) => {
    // Stats are decoration, not a gate: an unknown package renders as "no
    // data" rather than an error.
    const body = await fetchJson(url, DownloadsRangeResponseSchema, shared, { notFound: {} })
    const days = body.downloads
    if (!days) return NO_DOWNLOADS
    const daily = days.map((day) => day.downloads ?? 0)
    return { daily, weekly: daily.slice(-7).reduce((sum, count) => sum + count, 0) }
  })
}

export async function getAdvisories(name: string, version: string, deps: RegistryClientDeps = {}): Promise<RegistryAdvisories> {
  const safeName = assertSafeName(name)
  if (!isSafePackageVersion(version)) throw new Error(`[registry] Invalid version "${version}"`)
  if (!publicStatsAvailable(deps)) return NO_ADVISORIES
  const key = `${OSV_API_URL}/v1/query#${safeName}@${version}`
  return cached(advisoriesCache, key, deps, async (shared) => {
    const body = await fetchJson(`${OSV_API_URL}/v1/query`, OsvQueryResponseSchema, shared, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ package: { name: safeName, ecosystem: 'npm' }, version }),
    })
    const advisories: RegistryAdvisory[] = (body.vulns ?? []).flatMap((raw) => {
      const id = asString(raw.id)
      if (!id) return []
      return [{
        id,
        summary: asString(raw.summary) ?? (raw.details ?? '').slice(0, 160),
        severity: asString(raw.database_specific?.severity)?.toLowerCase() ?? null,
      }]
    })
    return { advisories }
  })
}
