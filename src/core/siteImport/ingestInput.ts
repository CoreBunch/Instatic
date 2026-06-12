/**
 * ingestInput — normalize any of the four import input shapes into a FileMap.
 *
 * Input shapes:
 *   - `File`         — a single file (browser File API)
 *   - `File[]`       — multiple files (loose multi-select or folder via
 *                      webkitdirectory; uses `webkitRelativePath` when set)
 *   - `{ zipBytes: Uint8Array }` — a ZIP archive; unpacked with fflate
 *   - `{ fileMap: FileMap }`    — passthrough (useful in tests)
 *
 * Path normalisation:
 *   - Separators normalised to `/`.
 *   - Hidden files (`.DS_Store`, `Thumbs.db`, `__MACOSX/*`, any
 *     dot-prefixed name) are silently dropped.
 *   - Paths containing `..`, leading `/`, or Windows drive letters are
 *     rejected with `PathTraversalError`.
 *
 * Validation limits (all configurable via options):
 *   - Aggregate compressed size > 1 GB → `OversizeImportError`
 *   - File count > 10 000               → `TooManyFilesError`
 *   - Zip uncompressed total > 5 GB     → `ZipBombError`
 *   - Empty input                       → `EmptyImportError`
 */

import { unzipSync } from 'fflate'
import type { FileMap } from './types'
import {
  EmptyImportError,
  OversizeImportError,
  ZipBombError,
  TooManyFilesError,
  PathTraversalError,
} from './types'

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024        // 1 GB
const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_ZIP_UNCOMPRESSED = 5 * 1024 * 1024 * 1024 // 5 GB

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

type IngestInput =
  | File
  | File[]
  | { zipBytes: Uint8Array }
  | { fileMap: FileMap }

interface IngestOptions {
  /** Max aggregate compressed bytes across all files. Default: 1 GB */
  maxBytes?: number
  /** Max number of files. Default: 10 000 */
  maxFiles?: number
  /** Max uncompressed bytes when unpacking a ZIP (zip-bomb guard). Default: 5 GB */
  maxUncompressedZipBytes?: number
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Convert backslashes to forward slashes. */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * Return true if the path should be silently dropped as a hidden/metadata
 * artifact. Checked AFTER normalising separators.
 */
function isHiddenPath(normalizedPath: string): boolean {
  const parts = normalizedPath.split('/')
  for (const part of parts) {
    // Dot-prefix files/directories
    if (part.startsWith('.')) return true
    // macOS quarantine folder emitted by Finder when compressing
    if (part === '__MACOSX') return true
    // Windows thumbnail cache
    if (part.toLowerCase() === 'thumbs.db') return true
  }
  return false
}

/**
 * Throw `PathTraversalError` if the normalised path contains `..`, an
 * absolute leading `/`, or a Windows drive letter like `C:`.
 */
function assertSafePath(path: string): void {
  if (path.includes('..')) throw new PathTraversalError(path)
  if (path.startsWith('/')) throw new PathTraversalError(path)
  // Windows drive letters: C: D: etc.
  if (/^[a-zA-Z]:/.test(path)) throw new PathTraversalError(path)
}

// ---------------------------------------------------------------------------
// FileMap builder
// ---------------------------------------------------------------------------

/**
 * Detect whether every path in `paths` shares a single top-level folder.
 * Returns the folder name when true (e.g. `"my-site"`), otherwise undefined.
 */
function detectSharedTopLevel(paths: string[]): string | undefined {
  if (paths.length === 0) return undefined
  const firstSegments = new Set<string>()
  for (const p of paths) {
    const seg = p.split('/')[0]
    if (!seg) return undefined
    firstSegments.add(seg)
    if (firstSegments.size > 1) return undefined
  }
  const [first] = firstSegments
  return first !== undefined ? first : undefined
}

/**
 * Strip a shared top-level folder from all paths.
 * e.g. `"my-site/index.html"` → `"index.html"` when folder is `"my-site"`.
 */
function stripTopLevelFolder(paths: Record<string, { bytes: Uint8Array; mimeType?: string }>, folder: string): Record<string, { bytes: Uint8Array; mimeType?: string }> {
  const prefix = `${folder}/`
  const result: Record<string, { bytes: Uint8Array; mimeType?: string }> = {}
  for (const [path, entry] of Object.entries(paths)) {
    const stripped = path.startsWith(prefix) ? path.slice(prefix.length) : path
    if (stripped) result[stripped] = entry
  }
  return result
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Normalise any of the four input shapes into a `FileMap`.
 *
 * @throws {EmptyImportError}     when no files remain after filtering.
 * @throws {OversizeImportError}  when aggregate size exceeds `maxBytes`.
 * @throws {TooManyFilesError}    when file count exceeds `maxFiles`.
 * @throws {ZipBombError}         when ZIP uncompressed size exceeds guard.
 * @throws {PathTraversalError}   when any path contains a traversal attempt.
 */
export async function ingestInput(
  input: IngestInput,
  options?: IngestOptions,
): Promise<FileMap> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES
  const maxUncompressed = options?.maxUncompressedZipBytes ?? DEFAULT_MAX_ZIP_UNCOMPRESSED

  // Passthrough
  if (typeof input === 'object' && !(input instanceof File) && 'fileMap' in input) {
    return input.fileMap
  }

  // ZIP bytes
  if (typeof input === 'object' && !(input instanceof File) && 'zipBytes' in input) {
    return ingestZip(input.zipBytes, maxBytes, maxFiles, maxUncompressed)
  }

  // File or File[] (browser File API)
  const files = Array.isArray(input) ? input : [input]
  return ingestFiles(files, maxBytes, maxFiles)
}

// ---------------------------------------------------------------------------
// ZIP ingestion
// ---------------------------------------------------------------------------

/**
 * Synchronously unpack a ZIP using fflate and build a FileMap.
 *
 * fflate's `unzipSync` throws on corrupt/invalid zips, which we let bubble
 * as-is (callers can catch Error to show a user-visible "corrupt zip" message).
 */
async function ingestZip(
  zipBytes: Uint8Array,
  maxBytes: number,
  maxFiles: number,
  maxUncompressed: number,
): Promise<FileMap> {
  // Compressed size check before paying the unzip cost
  if (zipBytes.byteLength > maxBytes) {
    throw new OversizeImportError(zipBytes.byteLength, maxBytes)
  }

  // fflate.unzipSync returns Record<path, Uint8Array>. Throws on corrupt zips.
  const entries = unzipSync(zipBytes)
  const entryPaths = Object.keys(entries)

  if (entryPaths.length > maxFiles) {
    throw new TooManyFilesError(entryPaths.length, maxFiles)
  }

  // Build FileMap, checking uncompressed size and filtering hidden paths
  const rawFiles: Record<string, { bytes: Uint8Array; mimeType?: string }> = {}
  let uncompressedTotal = 0

  for (const relPath of entryPaths) {
    const normalized = normalizeSlashes(relPath)
    assertSafePath(normalized)
    if (isHiddenPath(normalized)) continue
    // Skip directory entries — fflate.unzipSync surfaces them as
    // zero-byte records whose path ends with `/` (e.g. `styles/`,
    // `fonts/`). They're metadata, not files; the directory tree
    // already lives inside the actual file paths (`styles/site.css`).
    // Letting them through would later get picked up by the
    // unreferenced-asset sweep in assetPlan and uploaded as zero-byte
    // "media files".
    if (normalized.endsWith('/')) continue

    const bytes = entries[relPath]!
    uncompressedTotal += bytes.byteLength
    if (uncompressedTotal > maxUncompressed) {
      throw new ZipBombError(uncompressedTotal, maxUncompressed)
    }

    rawFiles[normalized] = { bytes }
  }

  if (Object.keys(rawFiles).length === 0) {
    throw new EmptyImportError()
  }

  // Detect and strip shared top-level folder
  const allPaths = Object.keys(rawFiles)
  const topLevel = detectSharedTopLevel(allPaths)
  const files = topLevel
    ? stripTopLevelFolder(rawFiles, topLevel)
    : rawFiles

  return { files, ...(topLevel ? { strippedTopLevelFolder: topLevel } : {}) }
}

// ---------------------------------------------------------------------------
// File[] ingestion (browser File objects)
// ---------------------------------------------------------------------------

async function ingestFiles(
  fileList: File[],
  maxBytes: number,
  maxFiles: number,
): Promise<FileMap> {
  if (fileList.length === 0) throw new EmptyImportError()
  if (fileList.length > maxFiles) throw new TooManyFilesError(fileList.length, maxFiles)

  const rawFiles: Record<string, { bytes: Uint8Array; mimeType?: string }> = {}
  let totalBytes = 0

  await Promise.all(
    fileList.map(async (file) => {
      // Use webkitRelativePath when available (folder upload or drag-and-drop
      // of a directory); fall back to file.name for plain file picks.
      const rawPath = (file.webkitRelativePath && file.webkitRelativePath.length > 0)
        ? file.webkitRelativePath
        : file.name

      const normalized = normalizeSlashes(rawPath)
      assertSafePath(normalized)
      if (isHiddenPath(normalized)) return

      totalBytes += file.size
      if (totalBytes > maxBytes) throw new OversizeImportError(totalBytes, maxBytes)

      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)

      const mimeType = file.type || undefined
      rawFiles[normalized] = { bytes, ...(mimeType ? { mimeType } : {}) }
    }),
  )

  if (Object.keys(rawFiles).length === 0) throw new EmptyImportError()

  return { files: rawFiles }
}
