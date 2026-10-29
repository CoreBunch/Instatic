/**
 * Site bundle archive import endpoint.
 *
 *   POST /admin/api/cms/import/archive?strategy=<strategy>
 *
 * Accepts the user-facing ZIP archive emitted by `/admin/api/cms/export`.
 * The manifest is the first stored entry, so the handler can validate the
 * selected media stream before applying site data. Selected media bytes are
 * staged in temporary files first, then moved into uploads after the data
 * import succeeds. The data half (capability gates, the transaction, a
 * `replace` media wipe) is the JSON endpoint's, shared through
 * Authorization comes from `./import.ts`; the shared transaction is
 * `applySiteBundle` in `./importApply.ts`.
 */
import { ZipBodyReader } from '../../archive/zipBodyReader'
import { applySiteBundle, removeDeletedMediaFiles } from './importApply'
import { BundlePublicationError } from '../../repositories/bundlePublication'
import { runtimeArchivePath, selectBundlePublication, type BundlePublication } from '@core/data/bundlePublication'
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
import type { BranchScope } from '../../branches/scope'
import {
  authorizeImportedShell,
  authorizeImportedPublication,
  validateImportedPublication,
  authorizeImportStrategy,
} from './import'

const IMPORT_ARCHIVE_PATH = `${CMS_API_PREFIX}/import/archive`
const ZIP_STORED_METHOD = 0
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
const MAX_ARCHIVE_MANIFEST_BYTES = 256 * 1024 * 1024

const textDecoder = new TextDecoder()

interface StagedArchiveMedia {
  stagingDir: string
  entries: StagedArchiveMediaEntry[]
}

interface StagedArchiveFiles extends StagedArchiveMedia {
  runtimeFiles: Map<string, Uint8Array>
}

interface StagedArchiveMediaEntry {
  asset: NonNullable<SiteBundleArchiveManifest['media']>[number]
  stagedPath: string
}

export async function handleImportArchiveRoute(
  req: Request,
  db: DbClient,
  scope: BranchScope,
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
  const strategyDenied = await authorizeImportStrategy(req, db, user, strategy)
  if (strategyDenied) return strategyDenied
  const selection = parseImportSelection(url)
  if (selection instanceof Response) return selection

  const selectedManifest = selection
    ? filterArchiveManifestForSelection(manifest, selection)
    : manifest

  const shellDenied = authorizeImportedShell(user, selectedManifest.site !== undefined)
  if (shellDenied) return shellDenied

  const publicationInvalid = validateImportedPublication(siteBundleWithoutMediaBytes(selectedManifest))
  if (publicationInvalid) return publicationInvalid
  const publicationDenied = await authorizeImportedPublication(req, db, user, siteBundleWithoutMediaBytes(selectedManifest))
  if (publicationDenied) return publicationDenied

  let stagedMedia: StagedArchiveFiles | null = null
  if ((manifest.media?.length ?? 0) > 0 || (manifest.publication?.files.length ?? 0) > 0) {
    try {
      stagedMedia = await stageArchiveEntries({
        reader,
        archiveManifest: manifest,
        selectedManifest,
      })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid CMS bundle archive')
    }
  }

  try {
    const applied = await applySiteBundle(db, scope, {
      bundle: siteBundleWithoutMediaBytes(selectedManifest),
      strategy,
      carriesMedia: selectedManifest.media !== undefined,
      runtimeFiles: stagedMedia?.runtimeFiles,
      uploadsDir: options.uploadsDir,
    })
    // After commit, before staged media moves in: a bundle file at a deleted
    // asset's storage path must land after the old bytes are removed.
    await removeDeletedMediaFiles(applied.deletedMedia)

    let mediaImported = 0
    if (stagedMedia && options.uploadsDir) {
      try {
        mediaImported = await importStagedArchiveMediaEntries({
          stagedMedia,
          db,
          uploadsDir: options.uploadsDir,
          importedFolderIds: applied.importedFolderIds,
        })
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : 'Invalid CMS bundle archive')
      }
    }

    const result: ImportResult = {
      ok: true,
      strategy,
      tablesAffected: applied.tablesAffected,
      rowsInserted: applied.rowsInserted,
      rowsReplaced: applied.rowsReplaced,
      rowsSkipped: applied.rowsSkipped,
      mediaImported,
      mediaFoldersImported: applied.mediaFoldersImported,
      redirectsImported: applied.redirectsImported,
    }
    parseValue(ImportResultSchema, result)
    return jsonResponse(result)
  } catch (err) {
    if (err instanceof BundlePublicationError) return badRequest(err.message)
    throw err
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

async function stageArchiveEntries(input: {
  reader: ZipBodyReader
  archiveManifest: SiteBundleArchiveManifest
  selectedManifest: SiteBundleArchiveManifest
}): Promise<StagedArchiveFiles> {
  const stagedMedia: StagedArchiveFiles = {
    stagingDir: await mkdtemp(join(tmpdir(), 'instatic-import-media-')),
    entries: [],
    runtimeFiles: new Map(),
  }

  try {
    await readArchiveEntries({
      ...input,
      async onRuntimeFile(asset, reader) {
        const stagedPath = join(stagedMedia.stagingDir, `runtime-${stagedMedia.runtimeFiles.size}.bin`)
        const crc = createCrc32()
        await writeEntryToFile(reader, stagedPath, asset.sizeBytes, crc)
        stagedMedia.runtimeFiles.set(asset.publicPath, new Uint8Array(await Bun.file(stagedPath).arrayBuffer()))
        return crc.digest()
      },
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

async function readArchiveEntries(input: {
  reader: ZipBodyReader
  archiveManifest: SiteBundleArchiveManifest
  selectedManifest: SiteBundleArchiveManifest
  onRuntimeFile: (asset: BundlePublication['files'][number], reader: ZipBodyReader) => Promise<number>
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

  const runtimeByPath = new Map((input.archiveManifest.publication?.files ?? []).map((file, index) => [runtimeArchivePath(index), file]))
  const selectedRuntime = new Set(input.selectedManifest.publication?.files.map((file) => file.publicPath) ?? [])

  while (true) {
    const header = await input.reader.readLocalHeader()
    if (!header) {
      if (selectedRuntime.size > 0) throw new Error('Archive is missing a published runtime file')
      const missingPath = selectedMediaByArchivePath.keys().next().value
      if (typeof missingPath === 'string') {
        throw new Error(`Archive is missing media file "${missingPath}"`)
      }
      return
    }
    if (header.compression !== ZIP_STORED_METHOD) {
      throw new Error(`Archive entry "${header.path}" is compressed; CMS bundle media must be stored`)
    }

    const runtimeFile = runtimeByPath.get(header.path)
    if (runtimeFile) {
      if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0 && (header.compressedSize !== runtimeFile.sizeBytes || header.uncompressedSize !== runtimeFile.sizeBytes)) {
        throw new Error('Runtime archive entry size does not match the manifest')
      }
      const crc = createCrc32()
      const crc32 = selectedRuntime.has(runtimeFile.publicPath)
        ? await input.onRuntimeFile(runtimeFile, input.reader)
        : (await drainEntry(input.reader, runtimeFile.sizeBytes, crc), crc.digest())
      if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0) await input.reader.readAndValidateDataDescriptor({ crc32, sizeBytes: runtimeFile.sizeBytes })
      if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0 && header.crc32 !== crc32) throw new Error('Published runtime file CRC does not match')
      runtimeByPath.delete(header.path)
      selectedRuntime.delete(runtimeFile.publicPath)
      continue
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

    if ((header.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0 && header.crc32 !== crc32) throw new Error('Media file CRC does not match')
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
    ...(manifest.publication ? { publication: selectBundlePublication(manifest.publication, selectedRowIds) } : {}),
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
