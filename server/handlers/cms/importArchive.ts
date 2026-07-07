/**
 * Site bundle archive import endpoint.
 *
 *   POST /admin/api/cms/import/archive?strategy=<strategy>
 *
 * Accepts the user-facing ZIP archive emitted by `/admin/api/cms/export`.
 * The manifest is the first stored entry, so the handler can validate the
 * selected media stream before applying site data. Selected media bytes are
 * staged in temporary files first, then moved into uploads after the data
 * import succeeds.
 */

import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { jsonResponse, badRequest } from '../../http'
import { importMediaAsset, assignAssetToFolders } from '../../repositories/media'
import { parseValue, formatValueErrors, compiled } from '@core/utils/typeboxHelpers'
import { validateAndSanitizeMediaBytes, resolveMediaWriteTarget } from './importMediaValidation'
import {
  ImportResultSchema,
  ImportStrategySchema,
  BundleImportSelectionSchema,
  SiteBundleSchema,
  type BundleImportSelection,
  type ImportResult,
  type ImportStrategy,
  type SiteBundle,
} from '@core/data/bundleSchema'
import {
  BUNDLE_ARCHIVE_MANIFEST_PATH,
  mediaArchivePath,
  SiteBundleArchiveManifestSchema,
  type SiteBundleArchiveManifest,
} from '@core/data/bundleArchive'
import { createCrc32 } from '../../archive/storedZip'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import { handleImportRoute } from './import'

const IMPORT_ARCHIVE_PATH = `${CMS_API_PREFIX}/import/archive`
const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50
const ZIP_DATA_DESCRIPTOR = 0x08074b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const ZIP_STORED_METHOD = 0
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
const UINT32_MAX = 0xffffffff
const MAX_ARCHIVE_MANIFEST_BYTES = 256 * 1024 * 1024

const textDecoder = new TextDecoder()

interface LocalHeader {
  path: string
  flags: number
  compression: number
  compressedSize: number | null
  uncompressedSize: number | null
}

interface StagedArchiveMedia {
  stagingDir: string
  entries: StagedArchiveMediaEntry[]
}

interface StagedArchiveMediaEntry {
  asset: NonNullable<SiteBundleArchiveManifest['media']>[number]
  stagedPath: string
}

export async function handleImportArchiveRoute(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== IMPORT_ARCHIVE_PATH) return null
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })

  const user = await requireCapability(req, db, 'data.import')
  if (user instanceof Response) return user
  if (!req.body) return badRequest('Import archive request body is required')

  const reader = new ZipBodyReader(req.body.getReader())
  let manifest: SiteBundleArchiveManifest
  try {
    manifest = await readArchiveManifest(reader)
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'Invalid CMS bundle archive')
  }

  const strategy = parseImportStrategy(url)
  if (strategy instanceof Response) return strategy
  const selection = parseImportSelection(url)
  if (selection instanceof Response) return selection

  const selectedManifest = selection
    ? filterArchiveManifestForSelection(manifest, selection)
    : manifest

  let stagedMedia: StagedArchiveMedia | null = null
  if (selectedManifest.media && selectedManifest.media.length > 0 && options.uploadsDir) {
    try {
      stagedMedia = await stageArchiveMediaEntries({
        reader,
        archiveManifest: manifest,
        selectedManifest,
      })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid CMS bundle archive')
    }
  }

  try {
    const dataBundle = siteBundleWithoutMediaBytes(selectedManifest)
    const dataImportReq = makeInternalImportRequest(req, strategy, dataBundle)
    const dataImportRes = await handleImportRoute(dataImportReq, db, options)
    if (!dataImportRes || !dataImportRes.ok) {
      return dataImportRes ?? jsonResponse({ error: 'Import route did not handle archive manifest' }, { status: 500 })
    }

    const baseResult = parseValue(ImportResultSchema, await dataImportRes.json())
    const importedFolderIds = new Set(
      strategy === 'replace'
        ? selectedManifest.mediaFolders?.map((folder) => folder.id) ?? []
        : [],
    )

    let mediaImported = 0
    if (stagedMedia && options.uploadsDir) {
      try {
        mediaImported = await importStagedArchiveMediaEntries({
          stagedMedia,
          db,
          uploadsDir: options.uploadsDir,
          importedFolderIds,
        })
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : 'Invalid CMS bundle archive')
      }
    }

    const result: ImportResult = {
      ...baseResult,
      mediaImported,
    }
    parseValue(ImportResultSchema, result)
    return jsonResponse(result)
  } finally {
    if (stagedMedia) {
      await cleanupStagedMedia(stagedMedia)
    }
  }
}

async function cleanupStagedMedia(stagedMedia: StagedArchiveMedia): Promise<void> {
  try {
    await rm(stagedMedia.stagingDir, { recursive: true, force: true })
  } catch (err) {
    console.warn('[importArchive] Failed to clean up staged media:', err)
  }
}

/**
 * Commit staged archive media entries to the uploads directory and the media
 * DB. Before writing each entry to disk, the bytes are validated and — for
 * SVG — sanitised, mirroring the security checks the normal upload pipeline
 * applies via `acceptUploadedMedia`.
 *
 * Exported for integration testing.
 */
export async function importStagedArchiveMediaEntries(input: {
  stagedMedia: StagedArchiveMedia
  db: DbClient
  uploadsDir: string
  importedFolderIds: Set<string>
}): Promise<number> {
  let imported = 0

  for (const { asset, stagedPath } of input.stagedMedia.entries) {
    const target = resolveMediaWriteTarget(input.uploadsDir, asset.storagePath)
    await mkdir(dirname(target), { recursive: true })

    // Security gate: detect the real MIME from magic bytes and sanitize SVG
    // before committing bytes to disk.  Reuses the same helpers as the normal
    // upload pipeline so there is exactly one place to update if the detection
    // or sanitisation logic changes. The staged file is fully buffered here to
    // sniff its magic bytes (unavoidable — MIME detection needs the head).
    const safeBytes = validateAndSanitizeMediaBytes(
      new Uint8Array(await Bun.file(stagedPath).arrayBuffer()),
      asset,
    )

    // SVG entries are written from the sanitized in-memory bytes; all other
    // types are moved from staging (zero-copy fast path).
    if (asset.mimeType === 'image/svg+xml') {
      await writeFile(target, safeBytes)
    } else {
      await moveFile(stagedPath, target)
    }

    await importMediaAsset(input.db, {
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      // Use the sanitized byte length — SVG shrinks after script removal.
      sizeBytes: safeBytes.length,
      storagePath: asset.storagePath,
      publicPath: `/uploads/${asset.storagePath}`,
      altText: asset.altText,
      caption: asset.caption,
      title: asset.title,
      tags: asset.tags,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      dominantColor: asset.dominantColor,
      blurHash: asset.blurHash,
      posterPath: asset.posterPath,
    })

    const targetFolders = asset.folderIds.filter((id) => input.importedFolderIds.has(id))
    if (targetFolders.length > 0) {
      await assignAssetToFolders(input.db, asset.id, { add: targetFolders })
    }
    imported++
  }

  return imported
}

async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
  } catch (err) {
    if (!errorHasCode(err, 'EXDEV')) throw err
    await copyFile(source, target)
    await unlink(source)
  }
}

function errorHasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === code
  )
}

async function stageArchiveMediaEntries(input: {
  reader: ZipBodyReader
  archiveManifest: SiteBundleArchiveManifest
  selectedManifest: SiteBundleArchiveManifest
}): Promise<StagedArchiveMedia> {
  const stagedMedia: StagedArchiveMedia = {
    stagingDir: await mkdtemp(join(tmpdir(), 'instatic-import-media-')),
    entries: [],
  }

  try {
    await readArchiveMediaEntries({
      ...input,
      async onSelectedMedia(asset, reader) {
        const stagedPath = join(stagedMedia.stagingDir, `${stagedMedia.entries.length}.bin`)
        const crc = createCrc32()
        await writeEntryToFile(reader, stagedPath, asset.sizeBytes, crc)
        stagedMedia.entries.push({ asset, stagedPath })
        return crc.digest()
      },
      async onUnselectedMedia(archivedAsset, reader) {
        const crc = createCrc32()
        await drainEntry(reader, archivedAsset.sizeBytes, crc)
        return crc.digest()
      },
    })
    return stagedMedia
  } catch (err) {
    await cleanupStagedMedia(stagedMedia)
    throw err
  }
}

async function readArchiveMediaEntries(input: {
  reader: ZipBodyReader
  archiveManifest: SiteBundleArchiveManifest
  selectedManifest: SiteBundleArchiveManifest
  onSelectedMedia: (
    asset: NonNullable<SiteBundleArchiveManifest['media']>[number],
    reader: ZipBodyReader,
  ) => Promise<number>
  onUnselectedMedia: (
    asset: NonNullable<SiteBundleArchiveManifest['media']>[number],
    reader: ZipBodyReader,
  ) => Promise<number>
}): Promise<void> {
  const allMediaByArchivePath = new Map(
    (input.archiveManifest.media ?? []).map((asset) => [mediaArchivePath(asset.storagePath), asset]),
  )
  const selectedMediaByArchivePath = new Map(
    (input.selectedManifest.media ?? []).map((asset) => [mediaArchivePath(asset.storagePath), asset]),
  )

  while (true) {
    const header = await input.reader.readLocalHeader()
    if (!header) {
      const missingPath = selectedMediaByArchivePath.keys().next().value
      if (typeof missingPath === 'string') {
        throw new Error(`Archive is missing media file "${missingPath}"`)
      }
      return
    }
    if (header.compression !== ZIP_STORED_METHOD) {
      throw new Error(`Archive entry "${header.path}" is compressed; CMS bundle media must be stored`)
    }

    const archivedAsset = allMediaByArchivePath.get(header.path)
    if (!archivedAsset) {
      throw new Error(`Unexpected entry in CMS bundle archive: ${header.path}`)
    }
    if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0) {
      if (header.compressedSize !== archivedAsset.sizeBytes || header.uncompressedSize !== archivedAsset.sizeBytes) {
        throw new Error(`Archive entry "${header.path}" size does not match the manifest`)
      }
    }

    const asset = selectedMediaByArchivePath.get(header.path)
    const crc32 = asset
      ? await input.onSelectedMedia(asset, input.reader)
      : await input.onUnselectedMedia(archivedAsset, input.reader)

    if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
      await input.reader.readAndValidateDataDescriptor({
        crc32,
        sizeBytes: archivedAsset.sizeBytes,
      })
    }

    allMediaByArchivePath.delete(header.path)
    selectedMediaByArchivePath.delete(header.path)
  }
}

function parseImportStrategy(url: URL): ImportStrategy | Response {
  const strategyParam = url.searchParams.get('strategy') ?? 'replace'
  try {
    return parseValue(ImportStrategySchema, strategyParam)
  } catch {
    return jsonResponse(
      { error: 'Invalid strategy — must be replace, merge-add, or merge-overwrite' },
      { status: 400 },
    )
  }
}

function parseImportSelection(url: URL): BundleImportSelection | null | Response {
  const raw = url.searchParams.get('selection')
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return jsonResponse({ error: 'Invalid import selection JSON' }, { status: 400 })
  }

  try {
    return parseValue(BundleImportSelectionSchema, parsed)
  } catch {
    return jsonResponse(
      { error: `Invalid import selection: ${formatValueErrors(BundleImportSelectionSchema, parsed)}` },
      { status: 400 },
    )
  }
}

function makeInternalImportRequest(req: Request, strategy: ImportStrategy, bundle: SiteBundle): Request {
  const url = new URL(`${CMS_API_PREFIX}/import`, req.url)
  url.searchParams.set('strategy', strategy)
  const headers = new Headers(req.headers)
  headers.set('content-type', 'application/json')
  headers.delete('content-length')
  const internalReq = new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(bundle),
  })
  const cookie = req.headers.get('cookie')
  if (cookie) internalReq.headers.set('cookie', cookie)
  return internalReq
}

function siteBundleWithoutMediaBytes(manifest: SiteBundleArchiveManifest): SiteBundle {
  const bundle: Partial<SiteBundleArchiveManifest> = { ...manifest }
  delete bundle.media
  return parseValue(SiteBundleSchema, bundle)
}

function filterArchiveManifestForSelection(
  manifest: SiteBundleArchiveManifest,
  selection: BundleImportSelection,
): SiteBundleArchiveManifest {
  const tableSelections = new Map(selection.tables.map((entry) => [entry.tableId, entry]))
  const tables = manifest.tables.filter((table) => tableSelections.has(table.id))
  const slugOverrides = rowSlugOverrideMap(selection)
  const rows = manifest.rows
    .filter((row) => {
      const tableSelection = tableSelections.get(row.tableId)
      if (!tableSelection) return false
      if (tableSelection.rowIds === undefined) return true
      return tableSelection.rowIds.includes(row.id)
    })
    .map((row) => applyRowSlugOverride(row, slugOverrides.get(rowOverrideKey(row.tableId, row.id))))
  const selectedRowIds = new Set(rows.map((row) => row.id))
  const media = filterArchiveManifestMedia(manifest, selection)
  const redirects = selection.includeRedirects && manifest.redirects
    ? manifest.redirects.filter((redirect) => selectedRowIds.has(redirect.targetRowId))
    : undefined

  return parseValue(SiteBundleArchiveManifestSchema, {
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    ...(manifest.sourceSiteName !== undefined ? { sourceSiteName: manifest.sourceSiteName } : {}),
    ...(selection.includeSite && manifest.site ? { site: manifest.site } : {}),
    tables,
    rows,
    ...(media ? { media } : {}),
    ...(selection.includeMediaFolders && manifest.mediaFolders ? { mediaFolders: manifest.mediaFolders } : {}),
    ...(redirects ? { redirects } : {}),
  })
}

function rowSlugOverrideMap(selection: BundleImportSelection): Map<string, string> {
  return new Map((selection.rowSlugOverrides ?? []).map((override) => [
    rowOverrideKey(override.tableId, override.rowId),
    override.slug,
  ]))
}

function rowOverrideKey(tableId: string, rowId: string): string {
  return `${tableId}:${rowId}`
}

function applyRowSlugOverride(
  row: SiteBundleArchiveManifest['rows'][number],
  slug: string | undefined,
): SiteBundleArchiveManifest['rows'][number] {
  if (!slug) return row
  return {
    ...row,
    slug,
    cells: typeof row.cells.slug === 'string'
      ? { ...row.cells, slug }
      : row.cells,
  }
}

function filterArchiveManifestMedia(
  manifest: SiteBundleArchiveManifest,
  selection: BundleImportSelection,
): SiteBundleArchiveManifest['media'] | undefined {
  if (!selection.includeMedia || !manifest.media) return undefined
  if (selection.mediaIds === undefined) return manifest.media
  const selectedIds = new Set(selection.mediaIds)
  return manifest.media.filter((asset) => selectedIds.has(asset.id))
}

async function readArchiveManifest(reader: ZipBodyReader): Promise<SiteBundleArchiveManifest> {
  const header = await reader.readLocalHeader()
  if (!header) throw new Error('CMS bundle archive is empty')
  if (header.path !== BUNDLE_ARCHIVE_MANIFEST_PATH) {
    throw new Error(`CMS bundle archive must start with "${BUNDLE_ARCHIVE_MANIFEST_PATH}"`)
  }
  if (header.compression !== ZIP_STORED_METHOD) {
    throw new Error('CMS bundle manifest must be stored without compression')
  }
  if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) {
    throw new Error('CMS bundle manifest must declare its size in the local header')
  }
  const size = header.compressedSize
  if (size === null) throw new Error('CMS bundle manifest is missing size metadata')
  if (size > MAX_ARCHIVE_MANIFEST_BYTES) {
    throw new Error('CMS bundle manifest is too large to preview safely')
  }

  const bytes = await reader.readExact(size)
  if (!bytes) throw new Error('CMS bundle manifest is truncated')

  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(bytes))
  } catch (err) {
    throw new Error(
      `Invalid archive manifest JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      { cause: err },
    )
  }

  try {
    return parseValue(SiteBundleArchiveManifestSchema, parsed)
  } catch {
    const firstPath = compiled(SiteBundleArchiveManifestSchema).Errors(parsed).First()?.path ?? ''
    throw new Error(`Archive manifest does not match schema at ${firstPath}: ${formatValueErrors(SiteBundleArchiveManifestSchema, parsed)}`)
  }
}

async function drainEntry(
  reader: ZipBodyReader,
  sizeBytes: number,
  crc: ReturnType<typeof createCrc32>,
): Promise<void> {
  await reader.copyExact(sizeBytes, async (chunk) => {
    crc.update(chunk)
  })
}

async function writeEntryToFile(
  reader: ZipBodyReader,
  target: string,
  sizeBytes: number,
  crc: ReturnType<typeof createCrc32>,
): Promise<void> {
  const stream = createWriteStream(target)
  try {
    await reader.copyExact(sizeBytes, async (chunk) => {
      crc.update(chunk)
      if (!stream.write(chunk)) await once(stream, 'drain')
    })
    stream.end()
    await once(stream, 'finish')
  } catch (err) {
    stream.destroy()
    throw err
  }
}

class ZipBodyReader {
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private ended = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader
  }

  async readLocalHeader(): Promise<LocalHeader | null> {
    const signatureBytes = await this.readExact(4)
    if (!signatureBytes) return null
    const signature = readUint32(signatureBytes, 0)
    if (
      signature === ZIP_CENTRAL_DIRECTORY_HEADER ||
      signature === ZIP_END_OF_CENTRAL_DIRECTORY ||
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY ||
      signature === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
    ) {
      return null
    }
    if (signature !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error('Invalid ZIP local file header in CMS bundle archive')
    }

    const rest = await this.readExact(26)
    if (!rest) throw new Error('Truncated ZIP local file header')
    const flags = readUint16(rest, 2)
    const compression = readUint16(rest, 4)
    const compressedSize32 = readUint32(rest, 14)
    const uncompressedSize32 = readUint32(rest, 18)
    const fileNameLength = readUint16(rest, 22)
    const extraLength = readUint16(rest, 24)
    const metadata = await this.readExact(fileNameLength + extraLength)
    if (!metadata) throw new Error('Truncated ZIP local file metadata')

    const path = textDecoder.decode(metadata.subarray(0, fileNameLength))
    const extra = metadata.subarray(fileNameLength)
    const zip64Sizes = compressedSize32 === UINT32_MAX || uncompressedSize32 === UINT32_MAX
      ? readZip64LocalSizes(extra)
      : null

    return {
      path,
      flags,
      compression,
      compressedSize: compressedSize32 === UINT32_MAX ? zip64Sizes?.compressedSize ?? null : compressedSize32,
      uncompressedSize: uncompressedSize32 === UINT32_MAX ? zip64Sizes?.uncompressedSize ?? null : uncompressedSize32,
    }
  }

  async readExact(size: number): Promise<Uint8Array<ArrayBufferLike> | null> {
    if (size === 0) return new Uint8Array(0)
    while (this.pending.byteLength < size && !this.ended) {
      const next = await this.reader.read()
      if (next.done) {
        this.ended = true
        break
      }
      const merged = new Uint8Array(this.pending.byteLength + next.value.byteLength)
      merged.set(this.pending, 0)
      merged.set(next.value, this.pending.byteLength)
      this.pending = merged
    }
    if (this.pending.byteLength === 0 && this.ended) return null
    if (this.pending.byteLength < size) throw new Error('CMS bundle archive ended unexpectedly')
    const out = this.pending.slice(0, size)
    this.pending = this.pending.slice(size)
    return out
  }

  async copyExact(
    size: number,
    writeChunk: (chunk: Uint8Array<ArrayBufferLike>) => Promise<void>,
  ): Promise<void> {
    let remaining = size
    while (remaining > 0) {
      if (this.pending.byteLength === 0) {
        const next = await this.reader.read()
        if (next.done) throw new Error('CMS bundle archive media entry is truncated')
        this.pending = next.value
      }
      const chunkSize = Math.min(remaining, this.pending.byteLength)
      const chunk = this.pending.subarray(0, chunkSize)
      await writeChunk(chunk)
      this.pending = this.pending.subarray(chunkSize)
      remaining -= chunkSize
    }
  }

  async readAndValidateDataDescriptor(expected: { crc32: number; sizeBytes: number }): Promise<void> {
    const descriptorSize = expected.sizeBytes > UINT32_MAX ? 24 : 16
    const descriptor = await this.readExact(descriptorSize)
    if (!descriptor) throw new Error('CMS bundle archive media descriptor is missing')
    if (readUint32(descriptor, 0) !== ZIP_DATA_DESCRIPTOR) {
      throw new Error('CMS bundle archive media descriptor is invalid')
    }
    const actualCrc = readUint32(descriptor, 4)
    const actualCompressedSize = expected.sizeBytes > UINT32_MAX
      ? Number(readUint64(descriptor, 8))
      : readUint32(descriptor, 8)
    const actualUncompressedSize = expected.sizeBytes > UINT32_MAX
      ? Number(readUint64(descriptor, 16))
      : readUint32(descriptor, 12)
    if (
      actualCrc !== expected.crc32 ||
      actualCompressedSize !== expected.sizeBytes ||
      actualUncompressedSize !== expected.sizeBytes
    ) {
      throw new Error('CMS bundle archive media descriptor does not match the streamed bytes')
    }
  }
}

function readZip64LocalSizes(extra: Uint8Array): { uncompressedSize: number; compressedSize: number } | null {
  let offset = 0
  while (offset + 4 <= extra.byteLength) {
    const headerId = readUint16(extra, offset)
    const dataSize = readUint16(extra, offset + 2)
    const dataStart = offset + 4
    const dataEnd = dataStart + dataSize
    if (dataEnd > extra.byteLength) return null
    if (headerId === ZIP64_EXTRA_FIELD_ID) {
      if (dataSize < 16) return null
      return {
        uncompressedSize: Number(readUint64(extra, dataStart)),
        compressedSize: Number(readUint64(extra, dataStart + 8)),
      }
    }
    offset = dataEnd
  }
  return null
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true)
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true)
}
