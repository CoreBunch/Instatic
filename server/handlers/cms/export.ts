/**
 * Site bundle export endpoint.
 *
 *   GET  /admin/api/cms/export
 *   POST /admin/api/cms/export
 *   POST /admin/api/cms/export/estimate   → { bytes } (size only, no download)
 *
 * Returns a ZIP archive that captures a full or partial site state:
 *   - `.instatic/site-bundle.json` with the portable manifest
 *   - `media/<storagePath>` raw files when media is included
 *
 * The manifest contains:
 *   - optionally the lean site shell (breakpoints, settings, classes, files, runtime)
 *   - selected (or all) data tables
 *   - selected (or all) non-deleted data rows
 *   - optionally: non-deleted media asset metadata
 *
 * The `/export/estimate` path runs the IDENTICAL selection logic but reports
 * only the bundle's byte size — without reading media files off disk or
 * assembling the ZIP. The estimate is therefore exact: stored archive size
 * depends only on manifest bytes, entry names, and media byte lengths.
 *
 * Filter options (GET → query string, POST → JSON body or form field via ExportRequestSchema):
 *   tables       — comma-separated table ids (GET) or string[] (POST); default all
 *   rowIds       — comma-separated row ids (GET) or string[] (POST); default all
 *   includeMedia — `1`/`0` (GET) or boolean (POST); default false
 *   includeSite  — `1`/`0` (GET, default 1) or boolean (POST, default true)
 *
 * Requires the `data.export` capability — split out of `site.read` in
 * B8 because the bundle bytes include every author's drafts, which
 * `site.read` (held by Client) should not imply.
 *
 * Additionally: row visibility is filtered via `canSeeAllDataRows`.
 * A caller without `content.edit.any` / `content.publish.any` /
 * `content.manage` only exports their own rows. This closes the G5
 * leak (the previous implementation returned every row regardless of
 * the caller's content visibility scope).
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { getDraftSite } from '../../repositories/site'
import { listDataTables } from '../../repositories/data/tables'
import { listDataRows } from '../../repositories/data/rows'
import { listExportableRedirects } from '../../repositories/data/publish'
import { listMediaAssetsForExport, countMediaAssetsForExport } from '../../repositories/media'
import { listExportableMediaFolders } from '../../repositories/mediaFolders'
import { jsonResponse, readValidatedBody } from '../../http'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import { ExportRequestSchema, type MediaAssetMetadata, type SiteBundle } from '@core/data/bundleSchema'
import {
  BUNDLE_ARCHIVE_MANIFEST_PATH,
  mediaArchivePath,
  type SiteBundleArchiveManifest,
} from '@core/data/bundleArchive'
import { canSeeAllDataRows } from './data/access'
import { createStoredZipStream, estimateStoredZipSize, type StoredZipEntry } from '../../archive/storedZip'
import { resolveBranchScopeById, type BranchScope } from '../../branches/scope'

const EXPORT_PATH = `${CMS_API_PREFIX}/export`
const EXPORT_ESTIMATE_PATH = `${CMS_API_PREFIX}/export/estimate`
const EXPORT_SUMMARY_PATH = `${CMS_API_PREFIX}/export/summary`

/** A media asset row enriched with its storage path, as loaded for export. */
type ExportableAsset = Awaited<ReturnType<typeof listMediaAssetsForExport>>[number]

interface ExportArchiveAsset {
  asset: ExportableAsset
  filePath: string
  sizeBytes: number
}

/**
 * The metadata fields of a bundle media entry — everything except the Base64
 * payload. Shared by the real export (which appends the encoded bytes) and the
 * estimate (which appends an empty string and sizes the bytes analytically).
 */
function mediaEntryMetadata(asset: ExportableAsset, sizeBytes = asset.sizeBytes): MediaAssetMetadata {
  return {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes,
    altText: asset.altText,
    caption: asset.caption,
    title: asset.title,
    tags: asset.tags,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    dominantColor: asset.dominantColor,
    blurHash: asset.blurHash,
    storagePath: asset.storagePath,
    posterPath: asset.posterPath,
    folderIds: asset.folderIds,
  }
}

interface ExportSelection {
  shell: NonNullable<Awaited<ReturnType<typeof getDraftSite>>>
  tables: Awaited<ReturnType<typeof listDataTables>>
  rows: Awaited<ReturnType<typeof listDataRows>>
  includeMedia: boolean
  includeSite: boolean
  /** Folder tree, or undefined when folders weren't requested. */
  mediaFolders: SiteBundle['mediaFolders']
  /** Self-consistent redirect set, or undefined when redirects weren't requested. */
  redirects: SiteBundle['redirects']
}

export async function handleExportRoute(
  req: Request,
  db: DbClient,
  scope: BranchScope,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  const isEstimate = url.pathname === EXPORT_ESTIMATE_PATH
  const isSummary = url.pathname === EXPORT_SUMMARY_PATH
  if (url.pathname !== EXPORT_PATH && !isEstimate && !isSummary) return null
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  const user = await requireCapability(req, db, 'data.export')
  if (user instanceof Response) return user

  // Summary — total counts of the non-table export categories, so the dialog
  // can label and disable categories independent of the current selection.
  if (isSummary) {
    const [media, mediaFolders, redirects] = await Promise.all([
      countMediaAssetsForExport(db),
      listExportableMediaFolders(db),
      listExportableRedirects(db),
    ])
    return jsonResponse({ media, mediaFolders: mediaFolders.length, redirects: redirects.length })
  }

  // Parse filter options from query string (GET) or JSON body (POST). A
  // `selections` of `undefined` means "every table, all rows" (full export);
  // otherwise each entry names a table and, optionally, a row subset.
  let selections: { tableId: string; rowIds?: string[] }[] | undefined
  let includeMedia: boolean
  let includeSite: boolean
  let includeMediaFolders: boolean
  let includeRedirects: boolean
  // The form-POST download names its branch in the body (see ExportRequestSchema).
  let exportScope = scope

  if (req.method === 'POST') {
    const exportReq = await readValidatedBody(req, ExportRequestSchema, {
      formJsonField: 'exportRequest',
    })
    if (!exportReq) {
      return jsonResponse({ error: 'Invalid export request body' }, { status: 400 })
    }
    selections = exportReq.tables
    includeMedia = exportReq.includeMedia ?? false
    includeSite = exportReq.includeSite ?? true
    includeMediaFolders = exportReq.includeMediaFolders ?? true
    includeRedirects = exportReq.includeRedirects ?? true
    if (exportReq.branchId !== undefined) {
      const requested = await resolveBranchScopeById(db, exportReq.branchId)
      if (requested instanceof Response) return requested
      exportScope = requested
    }
  } else {
    // GET supports whole-table selection only (comma-separated ids); row-level
    // subsets are a POST-only concern (the export dialog always POSTs).
    const tablesParam = url.searchParams.get('tables')
    selections = tablesParam
      ? tablesParam.split(',').filter(Boolean).map((tableId) => ({ tableId }))
      : undefined
    includeMedia = url.searchParams.get('includeMedia') === '1'
    includeSite = url.searchParams.get('includeSite') !== '0'
    includeMediaFolders = url.searchParams.get('includeMediaFolders') !== '0'
    includeRedirects = url.searchParams.get('includeRedirects') !== '0'
  }

  // Always load the site shell — needed for sourceSiteName even when includeSite=false
  const shell = await getDraftSite(db, exportScope)
  if (!shell) {
    return jsonResponse({ error: 'Site not initialised — run setup before exporting' }, { status: 404 })
  }

  // Resolve the table set: all tables for a full export, or just the named ones.
  const selectionByTable = selections ? new Map(selections.map((s) => [s.tableId, s])) : null
  let tables = await listDataTables(db, exportScope)
  if (selectionByTable) {
    tables = tables.filter((t) => selectionByTable.has(t.id))
  }

  // Load rows per table (parallel), applying each table's row subset if one was
  // given. Visibility filtering: a caller without `content.edit.any` /
  // `content.publish.any` / `content.manage` only sees their own rows in the
  // bundle, so a Client with `data.export` can't download every author's drafts
  // (G5 fix — see capabilities review).
  const visibility = canSeeAllDataRows(user) ? {} : { ownerUserId: user.id }
  const rowsPerTable = await Promise.all(
    tables.map(async (table) => {
      const all = await listDataRows(db, exportScope, table.id, visibility)
      const sel = selectionByTable?.get(table.id)
      if (!sel?.rowIds) return all
      const want = new Set(sel.rowIds)
      return all.filter((r) => want.has(r.id))
    }),
  )
  const rows = rowsPerTable.flat()

  // Media folder tree — cheap; gather whenever requested.
  const mediaFolders = includeMediaFolders ? await listExportableMediaFolders(db) : undefined

  // Redirects — keep the bundle self-consistent: only include redirects whose
  // table AND target row are part of this export, so the import can restore
  // them without dangling foreign keys (both FKs cascade-delete in the schema).
  let redirects: SiteBundle['redirects']
  if (includeRedirects) {
    const selectedTableIds = new Set(tables.map((t) => t.id))
    const selectedRowIds = new Set(rows.map((r) => r.id))
    const all = await listExportableRedirects(db)
    redirects = all.filter(
      (r) => selectedTableIds.has(r.tableId) && selectedRowIds.has(r.targetRowId),
    )
  }

  const selection: ExportSelection = {
    shell,
    tables,
    rows,
    includeMedia,
    includeSite,
    mediaFolders,
    redirects,
  }

  // Media is embedded only when requested AND an uploads dir is configured —
  // both the estimate and the real export gate on this so they stay in sync.
  const wantMedia = includeMedia && Boolean(options.uploadsDir)
  const assets = wantMedia ? await listMediaAssetsForExport(db) : []
  const archiveAssets = wantMedia && options.uploadsDir
    ? await resolveArchiveAssets(assets, options.uploadsDir)
    : []

  if (isEstimate) {
    return estimateResponse(selection, wantMedia, archiveAssets)
  }

  return downloadResponse(selection, wantMedia, archiveAssets)
}

/**
 * Compute the exact ZIP byte size without reading media files. Export archives
 * use stored entries (no compression), so size depends only on manifest bytes,
 * entry names, and media byte lengths.
 */
function estimateResponse(
  selection: ExportSelection,
  wantMedia: boolean,
  assets: ExportArchiveAsset[],
): Response {
  const mediaMetadata: SiteBundleArchiveManifest['media'] = wantMedia
    ? assets.map(({ asset, sizeBytes }) => mediaEntryMetadata(asset, sizeBytes))
    : undefined

  const manifest = buildArchiveManifest(selection, mediaMetadata)
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const archiveEntries = [
    {
      path: BUNDLE_ARCHIVE_MANIFEST_PATH,
      sizeBytes: manifestBytes.byteLength,
      usesDataDescriptor: false,
    },
    ...(wantMedia
      ? assets.map(({ asset, sizeBytes }) => ({
          path: mediaArchivePath(asset.storagePath),
          sizeBytes,
        }))
      : []),
  ]

  return jsonResponse({ bytes: estimateStoredZipSize(archiveEntries) })
}

/** Build the full archive and stream it as a download. */
async function downloadResponse(
  selection: ExportSelection,
  wantMedia: boolean,
  assets: ExportArchiveAsset[],
): Promise<Response> {
  const media: SiteBundleArchiveManifest['media'] = wantMedia
    ? assets.map(({ asset, sizeBytes }) => mediaEntryMetadata(asset, sizeBytes))
    : undefined

  const manifest = buildArchiveManifest(selection, media)
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
  const archiveEntries: StoredZipEntry[] = [
    {
      path: BUNDLE_ARCHIVE_MANIFEST_PATH,
      sizeBytes: manifestBytes.byteLength,
      source: manifestBytes,
    },
    ...assets.map(({ asset, filePath, sizeBytes }) => ({
      path: mediaArchivePath(asset.storagePath),
      sizeBytes,
      source: filePath,
    })),
  ]

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
  return new Response(createStoredZipStream(archiveEntries), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="site-bundle-${timestamp}.zip"`,
    },
  })
}

async function resolveArchiveAssets(
  assets: ExportableAsset[],
  uploadsDir: string,
): Promise<ExportArchiveAsset[]> {
  const resolved = await Promise.all(
    assets.map(async (asset) => {
      try {
        const filePath = join(uploadsDir, asset.storagePath)
        const fileStat = await stat(filePath)
        if (!fileStat.isFile()) return null
        return { asset, filePath, sizeBytes: fileStat.size }
      } catch {
        // Missing files are omitted from both the manifest and the archive so
        // the exported bundle stays internally consistent.
        return null
      }
    }),
  )
  return resolved.filter((item): item is ExportArchiveAsset => item !== null)
}

/** Assemble the archive manifest from a selection plus already-resolved media metadata. */
function buildArchiveManifest(
  selection: ExportSelection,
  media: SiteBundleArchiveManifest['media'],
): SiteBundleArchiveManifest {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceSiteName: selection.shell.name,
    ...(selection.includeSite ? { site: selection.shell } : {}),
    tables: selection.tables,
    rows: selection.rows,
    ...(media !== undefined ? { media } : {}),
    ...(selection.mediaFolders !== undefined ? { mediaFolders: selection.mediaFolders } : {}),
    ...(selection.redirects !== undefined ? { redirects: selection.redirects } : {}),
  }
}
