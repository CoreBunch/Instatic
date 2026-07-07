/**
 * SiteBundle — the portable export/import format for a complete site snapshot.
 *
 * A bundle contains:
 *   - optionally: the site shell (breakpoints, settings, classes, files, runtime config)
 *   - all (or selected) data tables
 *   - all (or selected) data rows
 *   - optionally: non-deleted media assets
 *   - optionally: the media folder tree (assets carry their `folderIds` membership)
 *   - optionally: published-URL redirects (old route → row)
 *
 * Together these make a bundle a complete, portable *site* — re-importing into a
 * fresh instance reproduces the same published output, editor state, media
 * organisation, and routing. Instance-runtime state (sessions, audit logs) and
 * credentials (user passwords, AI provider keys) are deliberately NOT carried —
 * a portable bundle is not a place for secrets.
 *
 * This is the internal server import/preview payload. User-facing exports are
 * ZIP archives whose manifest omits `bytesBase64` and stores raw media bytes
 * under `media/<storagePath>`. The Site Import modal reads only the archive
 * manifest for preview, then posts the original ZIP to the archive import
 * endpoint so media bytes stream server-side instead of expanding in browser
 * memory. Direct/internal JSON imports still use this embedded-byte shape.
 *
 * Import side supports three strategies:
 *   - replace         — wipe everything, reimport from bundle (destructive)
 *   - merge-add       — insert rows/tables that don't exist; skip those that do
 *   - merge-overwrite — upsert rows/tables; overwrite existing content with bundle
 *
 * Variants are NOT included in media exports. Imported assets keep their
 * original bytes and metadata; the publisher falls back to the original until a
 * later upload/replace path regenerates variants.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { DataTableSchema, DataRowSchema, DataTableKindSchema } from './schemas'
import { SiteShellSchema } from '@core/page-tree'

// ---------------------------------------------------------------------------
// MediaAssetExport
// ---------------------------------------------------------------------------

/**
 * A media asset record serialized for the internal import payload.
 * `bytesBase64` holds the raw file bytes encoded as Base64. `storagePath` is
 * the relative path inside the uploads directory so the import handler can
 * write the file and reconstruct `publicPath` as `/uploads/<storagePath>`.
 *
 * Variants, folder memberships, and deleted/replaced timestamps are intentionally
 * omitted — variants fall back to the original, and the other fields are not
 * needed on a fresh import.
 */
/**
 * A safe relative path: no leading slash and no `..` path segment. Other
 * characters (spaces, parens, unicode) are allowed since media filenames are
 * arbitrary — the only goal is to forbid traversal/absolute escapes.
 */
const SAFE_RELATIVE_PATH_PATTERN = '^(?!/)(?!.*(?:^|/)\\.\\.(?:$|/)).+$'

export const MediaAssetMetadataSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Number(),
  altText: Type.String(),
  caption: Type.String(),
  title: Type.String(),
  tags: Type.Array(Type.String()),
  width: Type.Union([Type.Number(), Type.Null()]),
  height: Type.Union([Type.Number(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  dominantColor: Type.Union([Type.String(), Type.Null()]),
  blurHash: Type.Union([Type.String(), Type.Null()]),
  /**
   * Relative path inside the uploads directory, e.g. `"abc123-photo.jpg"`.
   * Must not start with `/` or contain a `..` segment — the import handler
   * writes file bytes to `join(uploadsDir, storagePath)`, so traversal here is
   * an arbitrary-file-write primitive (ISS-009). The sink re-asserts
   * containment via `assertPathWithin`; this is the boundary guard.
   */
  storagePath: Type.String({ pattern: SAFE_RELATIVE_PATH_PATTERN }),
  /** Video poster image path (relative to uploads dir), or null for non-video assets. */
  posterPath: Type.Union([Type.String({ pattern: SAFE_RELATIVE_PATH_PATTERN }), Type.Null()]),
  /**
   * Ids of the media folders this asset belongs to (many-to-many). Restored on
   * import only when the matching folders are present in `mediaFolders` —
   * assignments to folders that weren't exported are skipped.
   */
  folderIds: Type.Array(Type.String()),
})

export type MediaAssetMetadata = Static<typeof MediaAssetMetadataSchema>

export const MediaAssetExportSchema = Type.Intersect([
  MediaAssetMetadataSchema,
  Type.Object({
    /** Raw file bytes encoded as Base64. */
    bytesBase64: Type.String(),
  }),
])

export type MediaAssetExport = Static<typeof MediaAssetExportSchema>

// ---------------------------------------------------------------------------
// BundleMediaFolder
// ---------------------------------------------------------------------------

/**
 * A media-library folder serialized for transfer. The tree is rebuilt on import
 * from `parentId` links (null = root). `createdByUserId` is intentionally
 * omitted — folder authorship is instance-local and is reset to null on import,
 * exactly like data-row authorship references that can't be rehydrated.
 */
export const BundleMediaFolderSchema = Type.Object({
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  slug: Type.String(),
  sortOrder: Type.Number(),
})

export type BundleMediaFolder = Static<typeof BundleMediaFolderSchema>

// ---------------------------------------------------------------------------
// BundleRedirect
// ---------------------------------------------------------------------------

/**
 * A published-URL redirect (old route → row), serialized raw so it round-trips
 * faithfully. `targetRowId` references a row in `rows`; the export only includes
 * redirects whose table + target row are part of the bundle, so the import can
 * restore them without dangling foreign keys.
 */
export const BundleRedirectSchema = Type.Object({
  id: Type.String(),
  tableId: Type.String(),
  fromRouteBase: Type.String(),
  fromSlug: Type.String(),
  targetRowId: Type.String(),
})

export type BundleRedirect = Static<typeof BundleRedirectSchema>

// ---------------------------------------------------------------------------
// ImportStrategy
// ---------------------------------------------------------------------------

/**
 * Controls how an import merges the bundle with the local site state.
 *
 *   replace         — delete everything, reimport from bundle (destructive)
 *   merge-add       — only add what's missing; never overwrite existing content
 *   merge-overwrite — upsert: add missing, update existing with bundle values
 */
export const ImportStrategySchema = Type.Union([
  Type.Literal('replace'),
  Type.Literal('merge-add'),
  Type.Literal('merge-overwrite'),
])

export type ImportStrategy = Static<typeof ImportStrategySchema>

// ---------------------------------------------------------------------------
// ExportRequest
// ---------------------------------------------------------------------------

/**
 * One table's contribution to an export. `rowIds` omitted = the whole table
 * (all rows); `rowIds` present = only those rows. A table not listed in
 * `ExportRequest.tables` is excluded entirely.
 */
export const TableSelectionSchema = Type.Object({
  tableId: Type.String(),
  /** Restrict to these row ids. Omit to include every row in the table. */
  rowIds: Type.Optional(Type.Array(Type.String())),
})

export type TableSelection = Static<typeof TableSelectionSchema>

export const RowSlugOverrideSchema = Type.Object({
  tableId: Type.String(),
  rowId: Type.String(),
  slug: Type.String(),
})

export type RowSlugOverride = Static<typeof RowSlugOverrideSchema>

/**
 * Request body accepted by `POST /admin/api/cms/export` (and query string
 * equivalent for `GET`). All fields are optional — omitting them produces a
 * full-site export (every table, every row, shell + media + folders + redirects).
 */
export const ExportRequestSchema = Type.Object({
  /**
   * Tables to include, each with an optional row subset. Omit the whole field
   * for a full export (all tables, all rows). Per entry: omit `rowIds` for the
   * whole table, or list specific row ids for a subset. A table absent from
   * this array is not exported at all.
   */
  tables: Type.Optional(Type.Array(TableSelectionSchema)),
  /** Embed media asset bytes in the bundle (increases bundle size). Default false. */
  includeMedia: Type.Optional(Type.Boolean()),
  /** Include the site shell (breakpoints, settings, classes, files, runtime).
   *  Default true. Set to false for content-only exports. */
  includeSite: Type.Optional(Type.Boolean()),
  /** Include the media folder tree + each asset's folder membership. Default true. */
  includeMediaFolders: Type.Optional(Type.Boolean()),
  /** Include published-URL redirects (old route → row). Default true. */
  includeRedirects: Type.Optional(Type.Boolean()),
})

export type ExportRequest = Static<typeof ExportRequestSchema>

// ---------------------------------------------------------------------------
// BundleImportSelection
// ---------------------------------------------------------------------------

/**
 * Request-side filter for applying an already-exported bundle. The shape
 * mirrors export selection so the Site Import review navigator can apply the
 * exact categories and rows the operator left enabled.
 */
export const BundleImportSelectionSchema = Type.Object({
  includeSite: Type.Boolean(),
  tables: Type.Array(TableSelectionSchema),
  includeMedia: Type.Boolean(),
  /** Restrict imported media assets by id. Omit when `includeMedia` means all media. */
  mediaIds: Type.Optional(Type.Array(Type.String())),
  includeMediaFolders: Type.Boolean(),
  includeRedirects: Type.Boolean(),
  rowSlugOverrides: Type.Optional(Type.Array(RowSlugOverrideSchema)),
})

export type BundleImportSelection = Static<typeof BundleImportSelectionSchema>

// ---------------------------------------------------------------------------
// ExportEstimate
// ---------------------------------------------------------------------------

/**
 * Response of `POST /admin/api/cms/export/estimate`. Reports the byte size the
 * export archive WOULD have for the given `ExportRequest`, computed from the
 * exact same selection logic the real export uses — without reading media
 * files off disk. `bytes` is the stored ZIP size.
 */
export const ExportEstimateSchema = Type.Object({
  bytes: Type.Number(),
})

export type ExportEstimate = Static<typeof ExportEstimateSchema>

// ---------------------------------------------------------------------------
// ExportSummary
// ---------------------------------------------------------------------------

/**
 * Response of `GET /admin/api/cms/export/summary`. Total counts of the
 * non-table export categories, so the export dialog can label each category
 * ("Media — 24 files") and disable empty ones — independent of the current
 * selection. Data-table row counts come from the workspace, not this endpoint.
 */
export const ExportSummarySchema = Type.Object({
  /** Non-deleted media assets available to export. */
  media: Type.Number(),
  /** Media-library folders. */
  mediaFolders: Type.Number(),
  /** Published-URL redirects. */
  redirects: Type.Number(),
})

export type ExportSummary = Static<typeof ExportSummarySchema>

// ---------------------------------------------------------------------------
// BundlePreview
// ---------------------------------------------------------------------------

/**
 * Per-table diff entry returned by the preview endpoint. Describes what the
 * import would do to this table under the `replace` or `merge-*` strategies.
 */
const BundlePreviewTableEntrySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: DataTableKindSchema,
  /** Number of rows in the bundle for this table. */
  inBundle: Type.Number(),
  /** Rows in the bundle whose id already exists locally (would be overwritten by merge-overwrite). */
  willReplace: Type.Number(),
  /** Rows in the bundle whose id does not exist locally (new rows). */
  willAdd: Type.Number(),
  /** Current number of non-deleted rows in this table on the local instance. */
  currentLocal: Type.Number(),
})

export const BundleRowConflictSchema = Type.Object({
  tableId: Type.String(),
  tableName: Type.String(),
  rowId: Type.String(),
  rowTitle: Type.String(),
  slug: Type.String(),
  existingRowId: Type.String(),
  suggestedSlug: Type.String(),
})

export type BundleRowConflict = Static<typeof BundleRowConflictSchema>

/**
 * Read-only diff returned by `POST /admin/api/cms/import/preview`.
 * Shows the operator what would happen before they commit an import.
 */
export const BundlePreviewSchema = Type.Object({
  meta: Type.Object({
    exportedAt: Type.String(),
    sourceSiteName: Type.Union([Type.String(), Type.Null()]),
    schemaVersion: Type.Literal(1),
  }),
  tables: Type.Array(BundlePreviewTableEntrySchema),
  rowConflicts: Type.Optional(Type.Array(BundleRowConflictSchema)),
  totals: Type.Object({
    rows: Type.Number(),
    mediaFiles: Type.Number(),
    mediaEmbedded: Type.Boolean(),
    mediaFolders: Type.Number(),
    redirects: Type.Number(),
  }),
})

export type BundlePreview = Static<typeof BundlePreviewSchema>

// ---------------------------------------------------------------------------
// ImportResult
// ---------------------------------------------------------------------------

/**
 * Success response returned by `POST /admin/api/cms/import`.
 * Counters describe what actually happened, broken down by strategy semantics.
 */
export const ImportResultSchema = Type.Object({
  ok: Type.Literal(true),
  strategy: ImportStrategySchema,
  tablesAffected: Type.Number(),
  rowsInserted: Type.Number(),
  rowsReplaced: Type.Number(),
  rowsSkipped: Type.Number(),
  mediaImported: Type.Number(),
  mediaFoldersImported: Type.Number(),
  redirectsImported: Type.Number(),
})

export type ImportResult = Static<typeof ImportResultSchema>

// ---------------------------------------------------------------------------
// SiteBundle
// ---------------------------------------------------------------------------

export const SiteBundleSchema = Type.Object({
  /** Schema version for forward-compat checks. Always 1 for this format. */
  schemaVersion: Type.Literal(1),
  /** ISO 8601 datetime string recording when the bundle was created. */
  exportedAt: Type.String(),
  /** Human-readable name of the site that produced this bundle. */
  sourceSiteName: Type.Optional(Type.String()),
  /**
   * The lean site shell: breakpoints, settings, classes, files, runtime.
   * Optional — omitted for content-only exports (`includeSite: false`).
   * Does NOT include pages or visual components — those are in `rows`.
   */
  site: Type.Optional(SiteShellSchema),
  /** All (or selected) data tables including system tables. */
  tables: Type.Array(DataTableSchema),
  /** All (or selected) non-deleted data rows. */
  rows: Type.Array(DataRowSchema),
  /** Non-deleted media assets with embedded bytes (optional — may be omitted to keep bundle small). */
  media: Type.Optional(Type.Array(MediaAssetExportSchema)),
  /** Media-library folder tree (optional). Asset membership rides on `media[].folderIds`. */
  mediaFolders: Type.Optional(Type.Array(BundleMediaFolderSchema)),
  /** Published-URL redirects (optional). Each targets a row present in `rows`. */
  redirects: Type.Optional(Type.Array(BundleRedirectSchema)),
})

export type SiteBundle = Static<typeof SiteBundleSchema>
