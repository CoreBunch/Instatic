/**
 * Site Runtime — TypeBox schemas and derived types.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof Schema>`.
 * No parallel TypeScript interfaces — schema definitions ARE the contract.
 *
 * Exception: `RuntimeScriptImportAnalysis` is a plain TypeScript interface
 * (no schema) because the `usage` field is a JS Map — not JSON-serializable.
 * This type is never persisted or sent over HTTP; it is only used as a function
 * return type inside the import-analysis pipeline.
 */

import { Type, type Static } from '@sinclair/typebox'
import { withFallback } from '@core/utils/typeboxHelpers'
import { SiteFileSchema } from '@core/files/schemas'

// ---------------------------------------------------------------------------
// LockedSiteDependency
// ---------------------------------------------------------------------------

const LockedSiteDependencySchema = Type.Object({
  name: Type.String(),
  requested: Type.String(),
  version: Type.String(),
  integrity: Type.Optional(Type.String()),
  tarballUrl: Type.Optional(Type.String()),
  resolvedAt: Type.Number(),
})

export type LockedSiteDependency = Static<typeof LockedSiteDependencySchema>

// ---------------------------------------------------------------------------
// SiteDependencyLock
// ---------------------------------------------------------------------------

export const SiteDependencyLockSchema = Type.Object({
  /** Literal 1 — schema version, not a counter */
  version: Type.Literal(1),
  packages: Type.Record(Type.String(), LockedSiteDependencySchema),
  updatedAt: Type.Number(),
})

export type SiteDependencyLock = Static<typeof SiteDependencyLockSchema>

// ---------------------------------------------------------------------------
// SiteScriptPlacement
// ---------------------------------------------------------------------------

const SiteScriptPlacementSchema = Type.Union([
  Type.Literal('head'),
  Type.Literal('body-end'),
])

export type SiteScriptPlacement = Static<typeof SiteScriptPlacementSchema>

// ---------------------------------------------------------------------------
// SiteScriptTiming
// ---------------------------------------------------------------------------

const SiteScriptTimingSchema = Type.Union([
  Type.Literal('immediate'),
  Type.Literal('dom-ready'),
  Type.Literal('idle'),
])

export type SiteScriptTiming = Static<typeof SiteScriptTimingSchema>

// ---------------------------------------------------------------------------
// SiteScriptFormat
// ---------------------------------------------------------------------------

const SiteScriptFormatSchema = Type.Union([
  Type.Literal('module'),
  Type.Literal('classic'),
])

export type SiteScriptFormat = Static<typeof SiteScriptFormatSchema>

// ---------------------------------------------------------------------------
// SiteAssetScope — discriminated union on `type`
//
// Shared by scripts AND stylesheets: both can target all pages, an explicit
// list of pages, or an explicit list of template pages. The instatic UI
// drives both through the same multi-select scope picker.
// ---------------------------------------------------------------------------

const SiteAssetScopeSchema = withFallback(
  Type.Union([
    Type.Object({ type: Type.Literal('all-pages') }),
    Type.Object({ type: Type.Literal('pages'), pageIds: Type.Array(Type.String()) }),
    Type.Object({ type: Type.Literal('templates'), templatePageIds: Type.Array(Type.String()) }),
  ]),
  { type: 'all-pages' as const },
)

export type SiteAssetScope = Static<typeof SiteAssetScopeSchema>

// ---------------------------------------------------------------------------
// SiteScriptRuntimeConfig
// ---------------------------------------------------------------------------

const SiteScriptResourceOriginsSchema = Type.Object({
  scripts: Type.Array(Type.String()),
  frames: Type.Array(Type.String()),
  connections: Type.Array(Type.String()),
  styles: Type.Optional(Type.Array(Type.String())),
  fonts: Type.Optional(Type.Array(Type.String())),
})

export type SiteScriptResourceOrigins = Static<typeof SiteScriptResourceOriginsSchema>

const SiteScriptRuntimeConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  runInCanvas: Type.Boolean(),
  format: Type.Optional(SiteScriptFormatSchema),
  placement: SiteScriptPlacementSchema,
  timing: SiteScriptTimingSchema,
  scope: SiteAssetScopeSchema,
  priority: Type.Number(),
  resourceOrigins: Type.Optional(SiteScriptResourceOriginsSchema),
})

export type SiteScriptRuntimeConfig = Static<typeof SiteScriptRuntimeConfigSchema>

// ---------------------------------------------------------------------------
// SiteStyleRuntimeConfig
//
// User-authored stylesheets (`site.files[type === 'style']`) carry the same
// targeting + ordering controls as scripts, minus placement/timing — those
// are script-only concepts (a `<link>` always lives in `<head>`). Cascade
// order within the published `userStyles` bundle is driven by `priority`
// (ascending), with `path` breaking ties.
// ---------------------------------------------------------------------------

const SiteStyleRuntimeConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  scope: SiteAssetScopeSchema,
  priority: Type.Number(),
})

export type SiteStyleRuntimeConfig = Static<typeof SiteStyleRuntimeConfigSchema>

// ---------------------------------------------------------------------------
// RuntimePackageImportmap
// ---------------------------------------------------------------------------

/**
 * Precomputed bare-specifier → URL map for the site's locked runtime
 * dependencies. Built once on the server by `buildRuntimePackageImportmap`
 * after `bun install` populates the cache, then attached to the site
 * runtime state so the editor's iframe sandbox and the published page
 * use identical URLs. URLs point at the host's
 * `/_instatic/runtime/cache/<lockHash>/<name>/<entry>` route.
 */
export const RuntimePackageImportmapSchema = Type.Object({
  /** `name` → entry-file URL, plus `name/` → package-root URL prefix. */
  imports: Type.Record(Type.String(), Type.String()),
  /** Cache hash this importmap was computed against. */
  lockHash: Type.String(),
})

export type RuntimePackageImportmap = Static<typeof RuntimePackageImportmapSchema>

// ---------------------------------------------------------------------------
// SiteRuntimeConfig
// ---------------------------------------------------------------------------

export const SiteRuntimeConfigSchema = Type.Object({
  dependencyLock: SiteDependencyLockSchema,
  scripts: Type.Record(Type.String(), SiteScriptRuntimeConfigSchema),
  /** Per-stylesheet targeting + cascade config, keyed by SiteFile id. */
  styles: Type.Record(Type.String(), SiteStyleRuntimeConfigSchema),
  /**
   * Stored alongside the lock so the editor can reach for the iframe's
   * import map without a round-trip — `setSiteDependencyLock` writes both
   * together. Absent when the lock has no resolved packages.
   */
  packageImportmap: Type.Optional(RuntimePackageImportmapSchema),
})

export type SiteRuntimeConfig = Static<typeof SiteRuntimeConfigSchema>

// ---------------------------------------------------------------------------
// SiteRuntimeTarget
// ---------------------------------------------------------------------------

const SiteRuntimeTargetSchema = Type.Union([
  Type.Literal('canvas'),
  Type.Literal('publish'),
])

export type SiteRuntimeTarget = Static<typeof SiteRuntimeTargetSchema>

// ---------------------------------------------------------------------------
// SiteRuntimeDiagnosticSeverity
// ---------------------------------------------------------------------------

const SiteRuntimeDiagnosticSeveritySchema = Type.Union([
  Type.Literal('error'),
  Type.Literal('warning'),
  Type.Literal('info'),
])


// ---------------------------------------------------------------------------
// SiteRuntimeDiagnostic
// ---------------------------------------------------------------------------

export const SiteRuntimeDiagnosticSchema = Type.Object({
  code: Type.String(),
  severity: SiteRuntimeDiagnosticSeveritySchema,
  message: Type.String(),
  fileId: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  line: Type.Optional(Type.Number()),
  column: Type.Optional(Type.Number()),
  packageName: Type.Optional(Type.String()),
})

export type SiteRuntimeDiagnostic = Static<typeof SiteRuntimeDiagnosticSchema>

// ---------------------------------------------------------------------------
// RuntimeImportKind
// ---------------------------------------------------------------------------

const RuntimeImportKindSchema = Type.Union([
  Type.Literal('static'),
  Type.Literal('dynamic'),
  Type.Literal('reexport'),
])

export type RuntimeImportKind = Static<typeof RuntimeImportKindSchema>

// ---------------------------------------------------------------------------
// RuntimeImportSpecifier
// ---------------------------------------------------------------------------

const RuntimeImportSpecifierSchema = Type.Object({
  specifier: Type.String(),
  kind: RuntimeImportKindSchema,
  start: Type.Number(),
  end: Type.Number(),
})

export type RuntimeImportSpecifier = Static<typeof RuntimeImportSpecifierSchema>

// ---------------------------------------------------------------------------
// RuntimePackageUsageFile
// ---------------------------------------------------------------------------

const RuntimePackageUsageFileSchema = Type.Object({
  fileId: Type.String(),
  path: Type.String(),
})


// ---------------------------------------------------------------------------
// RuntimePackageDependencyUsage
// ---------------------------------------------------------------------------

const RuntimePackageDependencyUsageSchema = Type.Object({
  name: Type.String(),
  requestedVersion: Type.Union([Type.String(), Type.Null()]),
  specifiers: Type.Array(Type.String()),
  files: Type.Array(RuntimePackageUsageFileSchema),
})

export type RuntimePackageDependencyUsage = Static<typeof RuntimePackageDependencyUsageSchema>

// ---------------------------------------------------------------------------
// PublishedRuntimeScriptAsset
// ---------------------------------------------------------------------------

const PublishedRuntimeScriptAssetSchema = Type.Object({
  fileId: Type.String(),
  src: Type.String(),
  format: Type.Optional(SiteScriptFormatSchema),
  placement: SiteScriptPlacementSchema,
  timing: SiteScriptTimingSchema,
  priority: Type.Number(),
  integrity: Type.Optional(Type.String()),
  resourceOrigins: Type.Optional(SiteScriptResourceOriginsSchema),
})

export type PublishedRuntimeScriptAsset = Static<typeof PublishedRuntimeScriptAssetSchema>

// ---------------------------------------------------------------------------
// PublishedPageRuntimeAssets
// ---------------------------------------------------------------------------

export const PublishedPageRuntimeAssetsSchema = Type.Object({
  scripts: Type.Array(PublishedRuntimeScriptAssetSchema),
})

export type PublishedPageRuntimeAssets = Static<typeof PublishedPageRuntimeAssetsSchema>

// ---------------------------------------------------------------------------
// RuntimeScriptEntry
// ---------------------------------------------------------------------------

const RuntimeScriptEntrySchema = Type.Object({
  file: SiteFileSchema,
  config: SiteScriptRuntimeConfigSchema,
})

export type RuntimeScriptEntry = Static<typeof RuntimeScriptEntrySchema>

// ---------------------------------------------------------------------------
// RuntimeScriptImportAnalysis
//
// Plain TypeScript interface — not schema-backed — because `usage` is a JS Map,
// which is not JSON-serializable. Never persisted or sent over HTTP.
// ---------------------------------------------------------------------------

export interface RuntimeScriptImportAnalysis {
  imports: RuntimeImportSpecifier[]
  usage: Map<string, RuntimePackageDependencyUsage>
  diagnostics: SiteRuntimeDiagnostic[]
}
