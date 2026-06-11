/**
 * Response-shape TypeBox schemas for the CMS persistence layer.
 *
 * Each `await res.json() as Foo` call site in this directory previously
 * trusted the server response without runtime checking. These schemas
 * tighten the boundary so a server-side regression returning the wrong
 * shape now produces a clear validation error instead of triggering an
 * undefined-access TypeError deep in callers.
 *
 * Strategy:
 *   - Shallow domain types (CmsMediaAsset, CmsPublishStatus, …) are
 *     validated fully — the schemas double as the source of truth.
 *   - Deep domain types that already own a canonical TypeBox schema in
 *     their module (FontEntry → @core/fonts; SiteDependencyLock,
 *     PublishedPageRuntimeAssets, SiteRuntimeDiagnostic,
 *     RuntimePackageImportmap → @core/site-runtime) are validated in full
 *     by referencing that schema directly. No `as DeepType` cast at the
 *     call site — the envelope guarantees the shape.
 *   - The few remaining deep types whose canonical definition is still a
 *     hand-authored interface (InstalledPlugin / PluginManifest in
 *     @core/plugin-sdk; the media-storage summary types) keep the
 *     envelope-only `Type.Unknown()` strategy and cast at the call site.
 *     Those sites are allowlisted in boundary-validation.test.ts (RULE 5)
 *     with a justification and are tracked as follow-up — converting their
 *     interfaces to schema-derived types is a plugin-SDK / media-storage
 *     refactor out of scope for this persistence-boundary pass.
 *
 * Surfaced by /audit-types — see #1 in /health-check report.
 */

import { Type, type Static } from '@sinclair/typebox'
import { DataRowSchema } from '@core/data/schemas'
import { FontEntrySchema } from '@core/fonts'
import {
  PublishedPageRuntimeAssetsSchema,
  RuntimePackageImportmapSchema,
  SiteDependencyLockSchema,
  SiteRuntimeDiagnosticSchema,
} from '@core/site-runtime'
export { BundlePreviewSchema, ImportResultSchema } from '@core/data/bundleSchema'
export type { BundlePreview, ImportResult } from '@core/data/bundleSchema'

// Re-exported types are inferred from the schemas below — these schemas are
// the source of truth, the types follow. Removes the previous duplication
// where each consumer module also declared its own TS interface.

// ---------------------------------------------------------------------------
// Error envelope used by every CMS endpoint. Defined in the generic HTTP layer
// (`@core/http`) and re-exported here for persistence-domain consumers.
// ---------------------------------------------------------------------------

export { ErrorEnvelopeSchema } from '@core/http'

// ---------------------------------------------------------------------------
// cmsAuth.ts
// ---------------------------------------------------------------------------

export const CmsSetupStatusSchema = Type.Object({
  hasSite: Type.Boolean(),
  hasAdmin: Type.Boolean(),
  hasOwner: Type.Optional(Type.Boolean()),
  needsSetup: Type.Boolean(),
})

export type CmsSetupStatus = Static<typeof CmsSetupStatusSchema>

/**
 * Site identity exposed to unauthenticated callers (the login / setup
 * screen). Returns the configured site name + favicon URL so the brand
 * row can render the operator's logo. Both fields are nullable: a fresh
 * install before `setup` has run resolves to `{ null, null }` and the
 * client falls back to the default mark.
 */
export const CmsPublicSiteSchema = Type.Object({
  name: Type.Union([Type.String(), Type.Null()]),
  faviconUrl: Type.Union([Type.String(), Type.Null()]),
})

export type CmsPublicSite = Static<typeof CmsPublicSiteSchema>

// ---------------------------------------------------------------------------
// cmsMedia.ts
// ---------------------------------------------------------------------------

/**
 * Wire schema for a media asset. The M2+ metadata fields are accepted as
 * optional so older test fixtures and the avatar endpoint — which still
 * returns the bare row shape — keep validating. `normalizeCmsMediaAsset` in
 * `cmsMedia.ts` runs at the client boundary to fill defaults, so the
 * exported `CmsMediaAsset` type that consumers see is always fully
 * populated.
 */
const CmsMediaVariantSchema = Type.Object({
  width: Type.Number(),
  height: Type.Number(),
  format: Type.Union([
    Type.Literal('webp'),
    Type.Literal('jpeg'),
    Type.Literal('png'),
    Type.Literal('avif'),
  ]),
  path: Type.String(),
  sizeBytes: Type.Number(),
})

const CmsMediaAssetSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Number(),
  publicPath: Type.String(),
  uploadedByUserId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  altText: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  width: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  height: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  durationMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  dominantColor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  deletedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  replacedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  folderIds: Type.Optional(Type.Array(Type.String())),
  blurHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  variants: Type.Optional(Type.Array(CmsMediaVariantSchema)),
  posterPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})

/**
 * Wire shape returned by the server. Use `CmsMediaAsset` (the normalized
 * type exported from `cmsMedia.ts`) when consuming asset data — that
 * variant fills in defaults for every optional field, so consumer code
 * never has to guard against `undefined`.
 */
export type CmsMediaAssetWire = Static<typeof CmsMediaAssetSchema>

export const CmsMediaListResponseSchema = Type.Object(
  { assets: Type.Optional(Type.Array(CmsMediaAssetSchema)) },
  { additionalProperties: true },
)

export const CmsMediaAssetEnvelopeSchema = Type.Object({
  asset: CmsMediaAssetSchema,
})

const CmsMediaFolderSchema = Type.Object({
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  slug: Type.String(),
  sortOrder: Type.Number(),
  createdByUserId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

export type CmsMediaFolder = Static<typeof CmsMediaFolderSchema>

export const CmsMediaFolderListResponseSchema = Type.Object(
  { folders: Type.Array(CmsMediaFolderSchema) },
  { additionalProperties: true },
)

export const CmsMediaFolderEnvelopeSchema = Type.Object({
  folder: CmsMediaFolderSchema,
})

// ---------------------------------------------------------------------------
// cmsPublish.ts
// ---------------------------------------------------------------------------

export const CmsPublishResultSchema = Type.Object({
  publishedPages: Type.Number(),
})

export type CmsPublishResult = Static<typeof CmsPublishResultSchema>

export const CmsPublishStatusSchema = Type.Object({
  hasPublishedVersion: Type.Boolean(),
  draftMatchesPublished: Type.Boolean(),
  draftPages: Type.Number(),
  publishedPages: Type.Number(),
  lastPublishedAt: Type.Optional(Type.String()),
})

export type CmsPublishStatus = Static<typeof CmsPublishStatusSchema>

// ---------------------------------------------------------------------------
// cmsRuntime.ts — fully validated against the @core/site-runtime schemas
// (the schemas are the source of truth; the editor-facing types are derived
// from them via Static<>, so the envelope catches server type-drift here
// instead of as undefined-in-UI deep in callers).
// ---------------------------------------------------------------------------

export const CmsRuntimeDependencyEnvelopeSchema = Type.Object({
  dependencyLock: SiteDependencyLockSchema,
  /**
   * Precomputed importmap built by the server from the freshly installed
   * dependency cache. Optional because the server may skip the install
   * step (e.g. lock resolution succeeded but install failed); the editor
   * keeps the lock either way and falls back to deferring iframe renders.
   */
  packageImportmap: Type.Optional(RuntimePackageImportmapSchema),
})

/**
 * One emitted asset (compiled script / stylesheet) in a runtime preview
 * build. Schema is the source of truth; `CmsRuntimePreviewAsset` in
 * `cmsRuntime.ts` is derived from it via Static<>.
 */
export const CmsRuntimePreviewAssetSchema = Type.Object({
  path: Type.String(),
  publicPath: Type.String(),
  content: Type.String(),
  contentType: Type.String(),
})

export type CmsRuntimePreviewAsset = Static<typeof CmsRuntimePreviewAssetSchema>

export const CmsRuntimePreviewResponseSchema = Type.Object(
  {
    html: Type.String(),
    assets: Type.Array(CmsRuntimePreviewAssetSchema),
    runtimeAssets: PublishedPageRuntimeAssetsSchema,
    diagnostics: Type.Array(SiteRuntimeDiagnosticSchema),
  },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// cms.ts — envelopes only; inner types are deep
// ---------------------------------------------------------------------------

export const CmsSiteEnvelopeSchema = Type.Object(
  { site: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

/**
 * Envelope for GET /admin/api/cms/pages.
 * Inner items are DataRow objects; validate them at the HTTP boundary before
 * converting through pageFromRow + validatePages in the adapter.
 */
export const CmsPagesEnvelopeSchema = Type.Object(
  { rows: Type.Optional(Type.Array(DataRowSchema)) },
  { additionalProperties: true },
)

/**
 * Envelope for GET /admin/api/cms/components.
 * Inner items are DataRow objects; validate them at the HTTP boundary before
 * converting through visualComponentFromRow + validateVisualComponents.
 */
export const CmsComponentsEnvelopeSchema = Type.Object(
  { rows: Type.Optional(Type.Array(DataRowSchema)) },
  { additionalProperties: true },
)

/**
 * Envelope for GET /admin/api/cms/layouts.
 * Inner items are DataRow objects; validate them at the HTTP boundary before
 * converting through savedLayoutFromRow + validateSavedLayouts.
 */
export const CmsLayoutsEnvelopeSchema = Type.Object(
  { rows: Type.Optional(Type.Array(DataRowSchema)) },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// fonts API — bundled Google directory + install/uninstall envelopes
// ---------------------------------------------------------------------------

const GoogleFontFamilySchema = Type.Object({
  family: Type.String(),
  category: Type.String(),
  subsets: Type.Array(Type.String()),
  variants: Type.Array(Type.String()),
  popularity: Type.Optional(Type.Number()),
})

export type GoogleFontFamilyDto = Static<typeof GoogleFontFamilySchema>

export const CmsGoogleFontsEnvelopeSchema = Type.Object({
  families: Type.Array(GoogleFontFamilySchema),
})

// The install/register responses return a fully-shaped FontEntry. We validate
// it against the canonical `FontEntrySchema` from @core/fonts (the source of
// truth that `site.settings.fonts` is also validated against) so server
// type-drift surfaces as a clear envelope error at the boundary instead of as
// an undefined field after the addFont action commits it.
export const CmsFontEntryEnvelopeSchema = Type.Object({
  font: FontEntrySchema,
})

/**
 * Pre-install size estimate for a (family × variants × subsets) request.
 * The server fetches the Google CSS2 stylesheets for the selection and HEADs
 * each woff2 URL, summing `Content-Length`. Some faces may not resolve (Google
 * occasionally drops a subset for a given variant) — `fileCount` reports how
 * many woff2 URLs actually contributed to `totalBytes`.
 */
export const CmsFontEstimateEnvelopeSchema = Type.Object({
  totalBytes: Type.Number(),
  fileCount: Type.Number(),
})

export type CmsFontEstimateDto = Static<typeof CmsFontEstimateEnvelopeSchema>

// ---------------------------------------------------------------------------
// cmsPlugins.ts — plugin pack install + schedules + schedule run envelopes
// ---------------------------------------------------------------------------

/**
 * Full response body from POST /admin/api/cms/plugins/:id/pack/install.
 * Schema is the source of truth; the TS type is derived via Static<>.
 */
export const CmsPluginPackInstallSummarySchema = Type.Object(
  {
    installed: Type.Object({
      visualComponents: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
      pages: Type.Array(Type.Object({ id: Type.String(), title: Type.String() })),
      classes: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
      layouts: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
    }),
    replaced: Type.Object({
      visualComponents: Type.Array(Type.String()),
      pages: Type.Array(Type.String()),
      classes: Type.Array(Type.String()),
      layouts: Type.Array(Type.String()),
    }),
  },
  { additionalProperties: true },
)

export type CmsPluginPackInstallSummary = Static<typeof CmsPluginPackInstallSummarySchema>

/**
 * Envelope for GET /admin/api/cms/plugins/:id/schedules.
 * CmsPluginScheduleSummary has a `cadence: unknown` field and the per-schedule
 * run arrays are deep; both pass through as Type.Unknown() and are cast at the
 * call site.
 */
export const CmsPluginSchedulesResponseEnvelopeSchema = Type.Object(
  {
    schedules: Type.Optional(Type.Array(Type.Unknown())),
    recent: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
)

/**
 * Envelope for POST /admin/api/cms/plugins/:id/schedules/:id/run-now.
 */
export const CmsPluginScheduleRunOutcomeEnvelopeSchema = Type.Object(
  {
    outcome: Type.Object({
      ok: Type.Boolean(),
      status: Type.String(),
      error: Type.Optional(Type.String()),
      durationMs: Type.Number(),
    }),
  },
  { additionalProperties: true },
)
