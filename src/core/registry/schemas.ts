/**
 * npm registry shapes shared by the server proxy (`server/registry/`) and the
 * admin Dependencies panel. The server maps upstream registry JSON into these
 * schemas; the client validates every proxied response against them, so the
 * panel never sees raw registry documents.
 */
import { Type, nullable, type Static } from '@core/utils/typeboxHelpers'

/** One page of registry search results. Both sides of the proxy build their paging on these. */
export const REGISTRY_SEARCH_PAGE_SIZE = 20
/** npm's search index stops answering past this offset; the proxy validates it and the panel stops paging there. */
export const REGISTRY_MAX_SEARCH_FROM = 5000

/** What the panel needs to know about the configured registry, served once per session. */
export const RegistryProfileSchema = Type.Object({
  /** Host of the configured registry, so the panel can name it. Credentials in the URL never travel. */
  host: Type.String(),
  /**
   * True for the public npm registry: its search qualifiers, npmjs.com links,
   * download statistics and OSV advisories all apply. A private registry or
   * mirror gets plain search and packuments only.
   */
  publicNpm: Type.Boolean(),
})
export type RegistryProfile = Static<typeof RegistryProfileSchema>

export const RegistrySearchSortSchema = Type.Union([
  Type.Literal('relevance'),
  Type.Literal('popularity'),
  Type.Literal('maintenance'),
])
export type RegistrySearchSort = Static<typeof RegistrySearchSortSchema>

const RegistrySearchHitSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  description: Type.String(),
  publisher: nullable(Type.String()),
  /** ISO timestamp of the listed version's publish, when the index has it. */
  date: nullable(Type.String()),
  weeklyDownloads: Type.Number(),
  dependents: Type.Number(),
  score: Type.Object({
    quality: Type.Number(),
    popularity: Type.Number(),
    maintenance: Type.Number(),
  }),
  insecure: Type.Boolean(),
})
export type RegistrySearchHit = Static<typeof RegistrySearchHitSchema>

export const RegistrySearchPageSchema = Type.Object({
  /** The registry's own total for the query. It over-counts: it is measured before uninstallable names are dropped. */
  total: Type.Number(),
  /**
   * How many entries the registry actually returned for this page, before
   * filtering. Fewer than the requested size means the result set is
   * exhausted, which `total` alone cannot tell the caller.
   */
  returned: Type.Number(),
  hits: Type.Array(RegistrySearchHitSchema),
})
export type RegistrySearchPage = Static<typeof RegistrySearchPageSchema>

const RegistryEsmEntrySchema = Type.Object({
  /** Package-relative path as written in the manifest (`./build/x.js` or `build/x.js`). */
  path: Type.String(),
  /** Which manifest field produced the entry — `main` alone is a CommonJS smell. */
  source: Type.Union([Type.Literal('exports'), Type.Literal('module'), Type.Literal('main')]),
})
export type RegistryEsmEntry = Static<typeof RegistryEsmEntrySchema>

const RegistryVersionInfoSchema = Type.Object({
  version: Type.String(),
  date: nullable(Type.String()),
  deprecated: nullable(Type.String()),
  license: nullable(Type.String()),
  dependencies: Type.Record(Type.String(), Type.String()),
  peerDependencies: Type.Record(Type.String(), Type.String()),
  unpackedSize: nullable(Type.Number()),
  fileCount: nullable(Type.Number()),
  esmEntry: nullable(RegistryEsmEntrySchema),
  hasTypes: Type.Boolean(),
})
export type RegistryVersionInfo = Static<typeof RegistryVersionInfoSchema>

export const RegistryPackageDetailsSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  latest: Type.String(),
  distTags: Type.Record(Type.String(), Type.String()),
  /** Newest first, capped by the server (`versionCount` carries the full total). */
  versions: Type.Array(RegistryVersionInfoSchema),
  versionCount: Type.Number(),
  readme: Type.String(),
  homepage: nullable(Type.String()),
  repository: nullable(Type.String()),
  /** The latest version's license, or the packument-level one for old packages that only declare it there. */
  license: nullable(Type.String()),
  maintainers: Type.Array(Type.String()),
  keywords: Type.Array(Type.String()),
  modified: nullable(Type.String()),
})
export type RegistryPackageDetails = Static<typeof RegistryPackageDetailsSchema>

export const RegistryDownloadsSchema = Type.Object({
  /** Daily download counts for the last 30 days, oldest first. Empty when unknown. */
  daily: Type.Array(Type.Number()),
  /** Sum of the last seven days of `daily`; null when the registry has no download statistics. */
  weekly: nullable(Type.Number()),
})
export type RegistryDownloads = Static<typeof RegistryDownloadsSchema>

const RegistryAdvisorySchema = Type.Object({
  id: Type.String(),
  summary: Type.String(),
  severity: nullable(Type.String()),
})
export type RegistryAdvisory = Static<typeof RegistryAdvisorySchema>

export const RegistryAdvisoriesSchema = Type.Object({
  advisories: Type.Array(RegistryAdvisorySchema),
})
export type RegistryAdvisories = Static<typeof RegistryAdvisoriesSchema>

export const RegistryLatestVersionSchema = Type.Object({
  /** The `latest` dist-tag, or null when the registry does not know the package. */
  version: nullable(Type.String()),
})
export type RegistryLatestVersion = Static<typeof RegistryLatestVersionSchema>
