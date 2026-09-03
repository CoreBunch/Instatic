/**
 * Client-side persistence layer for site-transfer endpoints:
 *   POST /admin/api/cms/export
 *   POST /admin/api/cms/import/preview
 *   POST /admin/api/cms/import?strategy=<strategy>
 *   POST /admin/api/cms/import/archive?strategy=<strategy>
 *
 * Export uses a same-origin browser form POST so the browser owns the attachment
 * download stream. Instatic archive import posts the original ZIP Blob to the
 * server-side streaming importer. Preview and import return standard JSON
 * envelopes validated with TypeBox via `readEnvelope`.
 */

import { strFromU8, unzipSync } from 'fflate'
import type { SiteBundle, BundlePreview, ImportResult, ImportStrategy, ExportRequest, ExportEstimate, ExportSummary, BundleImportSelection } from '@core/data/bundleSchema'
import { SiteBundleSchema, BundlePreviewSchema, ImportResultSchema, ExportEstimateSchema, ExportSummarySchema } from '@core/data/bundleSchema'
import {
  BUNDLE_ARCHIVE_MANIFEST_PATH,
  mediaArchivePath,
  SiteBundleArchiveManifestSchema,
  type SiteBundleArchiveManifest,
} from '@core/data/bundleArchive'
import { parseValue, formatValueErrors, compiled } from '@core/utils/typeboxHelpers'
import { apiRequest, readEnvelope, withAmbientHeaders } from '@core/http'

const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_STORED_METHOD = 0
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
const ZIP64_EXTRA_FIELD_ID = 0x0001
const UINT32_MAX = 0xffffffff
const MAX_ARCHIVE_MANIFEST_BYTES = 256 * 1024 * 1024
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// SiteBundleParseError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseSiteBundle` when the raw string fails JSON parsing or
 * TypeBox validation. Carries `path` so callers (e.g. an import dialog) can
 * show where in the bundle the problem was detected.
 *
 * `path` is `''` when the file is not valid JSON at all, or the first failing
 * TypeBox path (e.g. `'/schemaVersion'`) for structural validation errors.
 */
export class SiteBundleParseError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(message)
    this.name = 'SiteBundleParseError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// submitSiteBundleExport
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/export
 *
 * Starts a native browser attachment download through a hidden form POST. This
 * keeps arbitrary-length `rowIds` arrays out of the URL while avoiding
 * `fetch().blob()`, which forces large full-site bundles into JS blob storage
 * before the browser can save them.
 *
 * The export endpoint returns a zip attachment, not the standard `{ data,
 * error }` envelope — so this helper intentionally does not use `apiRequest`
 * / `readEnvelope`. A form POST cannot carry the ambient branch header
 * either, so the request names its branch in `branchId` (omitted on main).
 */
export function submitSiteBundleExport(opts: ExportRequest): void {
  if (typeof document === 'undefined' || !document.body) {
    throw new Error('Export download requires a browser document')
  }

  const targetName = `instatic-export-${Date.now()}-${Math.random().toString(36).slice(2)}`

  const iframe = document.createElement('iframe')
  iframe.name = targetName
  iframe.hidden = true
  iframe.setAttribute('aria-hidden', 'true')

  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/admin/api/cms/export'
  form.target = targetName
  form.enctype = 'application/x-www-form-urlencoded'
  form.hidden = true
  form.setAttribute('aria-hidden', 'true')

  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'exportRequest'
  input.value = JSON.stringify(opts)
  form.appendChild(input)

  document.body.append(iframe, form)
  try {
    form.submit()
  } catch (err) {
    form.remove()
    iframe.remove()
    throw err
  }

  // Keep the iframe mounted; removing the target can cancel slow attachment streams.
  form.remove()
}

// ---------------------------------------------------------------------------
// estimateSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/export/estimate
 *
 * Returns the exact byte size the bundle WOULD have for the given request,
 * computed server-side from the same selection logic as the real export (it
 * never reads media files off disk). Used to drive the "Estimated size" line
 * live as the operator toggles options. Pass an `AbortSignal` so superseded
 * requests cancel cleanly; detect cancellation with `isAbortError`.
 */
export async function estimateSiteBundle(
  opts: ExportRequest,
  signal?: AbortSignal,
): Promise<ExportEstimate> {
  return apiRequest('/admin/api/cms/export/estimate', {
    method: 'POST',
    body: opts,
    schema: ExportEstimateSchema,
    signal,
    fallbackMessage: 'Failed to estimate export size',
  })
}

// ---------------------------------------------------------------------------
// getExportSummary
// ---------------------------------------------------------------------------

/**
 * GET /admin/api/cms/export/summary
 *
 * Total counts of the non-table export categories (media, media folders,
 * redirects), so the export dialog can label each category and disable empty
 * ones — independent of the current selection. Data-table row counts come from
 * the workspace, not this endpoint.
 */
export async function getExportSummary(signal?: AbortSignal): Promise<ExportSummary> {
  return apiRequest('/admin/api/cms/export/summary', {
    method: 'GET',
    schema: ExportSummarySchema,
    signal,
    fallbackMessage: 'Failed to load export summary',
  })
}

// ---------------------------------------------------------------------------
// previewSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/import/preview
 *
 * Server validates the bundle and returns a read-only diff against the local
 * site. No DB writes are performed. Use this to show the operator what would
 * happen before they commit an import.
 */
export async function previewSiteBundle(bundle: SiteBundle): Promise<BundlePreview> {
  const res = await fetch('/admin/api/cms/import/preview', withAmbientHeaders({
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  }))
  return readEnvelope(res, BundlePreviewSchema, 'Failed to preview bundle')
}

// ---------------------------------------------------------------------------
// importSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/import?strategy=<strategy>
 *
 * Applies the bundle to the local instance using the given strategy:
 *   - `replace`         — wipe everything, reimport from bundle (destructive)
 *   - `merge-add`       — insert rows/tables that don't exist; skip existing
 *   - `merge-overwrite` — upsert: add missing, overwrite existing with bundle values
 */
export async function importSiteBundle(
  bundle: SiteBundle,
  strategy: ImportStrategy,
): Promise<ImportResult> {
  const res = await fetch(`/admin/api/cms/import?strategy=${encodeURIComponent(strategy)}`, withAmbientHeaders({
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  }))
  return readEnvelope(res, ImportResultSchema, 'Failed to import bundle')
}

export async function importSiteBundleArchive(
  archiveFile: Blob,
  strategy: ImportStrategy,
  selection?: BundleImportSelection,
): Promise<ImportResult> {
  const params = new URLSearchParams({ strategy })
  if (selection) params.set('selection', JSON.stringify(selection))

  const res = await fetch(`/admin/api/cms/import/archive?${params.toString()}`, withAmbientHeaders({
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/zip' },
    body: archiveFile,
  }))
  return readEnvelope(res, ImportResultSchema, 'Failed to import bundle')
}

// ---------------------------------------------------------------------------
// parseSiteBundle
// ---------------------------------------------------------------------------

/**
 * Parse and validate a `SiteBundle` from a raw JSON string (e.g. file
 * contents read by a `<input type="file">` handler).
 *
 * Throws `SiteBundleParseError` on failure:
 *   - `path: ''`    — the string is not valid JSON
 *   - `path: '/...'` — the JSON parses but fails TypeBox validation; path
 *                      points to the first failing location in the document
 */
export function parseSiteBundle(raw: string): SiteBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SiteBundleParseError(
      `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      '',
    )
  }

  try {
    return parseValue(SiteBundleSchema, parsed)
  } catch {
    // Collect the first TypeBox error to give a precise location.
    let firstPath = ''
    let message = 'Bundle does not match the expected SiteBundle schema'
    try {
      // formatValueErrors gives up to 5 issues; we also fish out the first
      // path separately so we can populate SiteBundleParseError.path.
      const firstErr = compiled(SiteBundleSchema).Errors(parsed).First()
      if (firstErr) {
        firstPath = firstErr.path
        message = formatValueErrors(SiteBundleSchema, parsed)
      }
    } catch {
      // Error collection itself failed — keep defaults.
    }
    throw new SiteBundleParseError(message, firstPath)
  }
}

// ---------------------------------------------------------------------------
// parseSiteBundleArchive
// ---------------------------------------------------------------------------

/**
 * Parse a CMS site-transfer ZIP archive. Returns `null` when the ZIP does not
 * contain the CMS archive manifest, so callers can route the ZIP through the
 * static-site importer. Throws `SiteBundleParseError` when a manifest is present
 * but malformed or references missing media entries.
 */
export function parseSiteBundleArchive(bytes: Uint8Array): SiteBundle | null {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    return null
  }

  const manifestBytes = entries[BUNDLE_ARCHIVE_MANIFEST_PATH]
  if (!manifestBytes) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(manifestBytes))
  } catch (err) {
    throw new SiteBundleParseError(
      `Invalid archive manifest JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      '',
    )
  }

  const manifest = parseSiteBundleArchiveManifestValue(parsed)

  const media = manifest.media?.map((asset, index) => {
    const path = mediaArchivePath(asset.storagePath)
    const mediaBytes = entries[path]
    if (!mediaBytes) {
      throw new SiteBundleParseError(`Archive is missing media file "${path}"`, `/media/${index}/storagePath`)
    }
    return {
      ...asset,
      bytesBase64: bytesToBase64(mediaBytes),
    }
  })

  return parseValue(SiteBundleSchema, {
    ...manifest,
    ...(media ? { media } : {}),
  })
}

export async function readSiteBundleArchiveManifestFile(
  archiveFile: Blob,
): Promise<SiteBundleArchiveManifest | null> {
  const header = new Uint8Array(await archiveFile.slice(0, 30).arrayBuffer())
  if (header.byteLength < 30) return null

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
  if (readUint32(view, 0) !== ZIP_LOCAL_FILE_HEADER) return null

  const flags = readUint16(view, 6)
  const compression = readUint16(view, 8)
  const compressedSize32 = readUint32(view, 18)
  const fileNameLength = readUint16(view, 26)
  const extraLength = readUint16(view, 28)

  const metadataStart = 30
  const metadataEnd = metadataStart + fileNameLength + extraLength
  if (metadataEnd > archiveFile.size) return null

  const metadata = new Uint8Array(await archiveFile.slice(metadataStart, metadataEnd).arrayBuffer())
  const fileName = textDecoder.decode(metadata.subarray(0, fileNameLength))
  if (fileName !== BUNDLE_ARCHIVE_MANIFEST_PATH) return null

  if (compression !== ZIP_STORED_METHOD) {
    throw new SiteBundleParseError('CMS archive manifest must be stored without compression', '')
  }
  if ((flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
    throw new SiteBundleParseError('CMS archive manifest must declare its size in the local header', '')
  }

  const extra = metadata.subarray(fileNameLength)
  const compressedSize = compressedSize32 === UINT32_MAX
    ? readZip64LocalSize(extra)
    : compressedSize32
  if (compressedSize === null) {
    throw new SiteBundleParseError('CMS archive manifest is missing ZIP64 size metadata', '')
  }
  if (compressedSize > MAX_ARCHIVE_MANIFEST_BYTES) {
    throw new SiteBundleParseError('CMS archive manifest is too large to preview safely', '')
  }

  const manifestStart = metadataEnd
  const manifestEnd = manifestStart + compressedSize
  if (manifestEnd > archiveFile.size) {
    throw new SiteBundleParseError('CMS archive manifest is truncated', '')
  }

  const manifestBytes = new Uint8Array(await archiveFile.slice(manifestStart, manifestEnd).arrayBuffer())
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(manifestBytes))
  } catch (err) {
    throw new SiteBundleParseError(
      `Invalid archive manifest JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      '',
    )
  }
  return parseSiteBundleArchiveManifestValue(parsed)
}

export function siteBundlePreviewFromArchiveManifest(manifest: SiteBundleArchiveManifest): SiteBundle {
  return parseValue(SiteBundleSchema, {
    ...manifest,
    ...(manifest.media
      ? {
          media: manifest.media.map((asset) => ({
            ...asset,
            bytesBase64: '',
          })),
        }
      : {}),
  })
}

function parseSiteBundleArchiveManifestValue(value: unknown): SiteBundleArchiveManifest {
  try {
    return parseValue(SiteBundleArchiveManifestSchema, value)
  } catch {
    throw new SiteBundleParseError(
      formatValueErrors(SiteBundleArchiveManifestSchema, value),
      firstSchemaErrorPath(SiteBundleArchiveManifestSchema, value),
    )
  }
}

function firstSchemaErrorPath(
  schema: Parameters<typeof formatValueErrors>[0],
  value: unknown,
): string {
  try {
    return compiled(schema).Errors(value).First()?.path ?? ''
  } catch {
    return ''
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    for (let i = 0; i < chunk.length; i++) {
      binary += String.fromCharCode(chunk[i]!)
    }
  }
  return btoa(binary)
}

function readZip64LocalSize(extra: Uint8Array): number | null {
  let offset = 0
  while (offset + 4 <= extra.byteLength) {
    const view = new DataView(extra.buffer, extra.byteOffset + offset, extra.byteLength - offset)
    const headerId = readUint16(view, 0)
    const dataSize = readUint16(view, 2)
    const dataStart = offset + 4
    const dataEnd = dataStart + dataSize
    if (dataEnd > extra.byteLength) return null
    if (headerId === ZIP64_EXTRA_FIELD_ID) {
      if (dataSize < 16) return null
      const zip64View = new DataView(extra.buffer, extra.byteOffset + dataStart, dataSize)
      return Number(zip64View.getBigUint64(8, true))
    }
    offset = dataEnd
  }
  return null
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}
