/**
 * Site runtime schema/type leaf.
 *
 * Consumers that only need persisted runtime shapes import this leaf instead of
 * the broad `@core/site-runtime` barrel, which also exports normalization and
 * import-analysis behavior.
 */

export type {
  LockedSiteDependency,
  PublishedPageRuntimeAssets,
  PublishedRuntimeScriptAsset,
  RuntimePackageDependencyUsage,
  RuntimePackageImportmap,
  RuntimeScriptEntry,
  SiteAssetScope,
  SiteDependencyLock,
  SiteRuntimeConfig,
  SiteRuntimeDiagnostic,
  SiteRuntimeTarget,
  SiteScriptFormat,
  SiteScriptPlacement,
  SiteScriptRuntimeConfig,
  SiteScriptTiming,
  SiteScriptResourceOrigins,
  SiteStyleRuntimeConfig,
} from '../site-runtime/schemas'

export {
  PublishedPageRuntimeAssetsSchema,
  RuntimePackageImportmapSchema,
  SiteDependencyLockSchema,
  SiteRuntimeConfigSchema,
  SiteRuntimeDiagnosticSchema,
} from '../site-runtime/schemas'
