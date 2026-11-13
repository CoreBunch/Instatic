/**
 * Fragment sources — the one read model `extractFragment` works on, built
 * either from a site-transfer bundle (the archive the export endpoint writes,
 * or its in-memory JSON form) or from a live editor `SiteDocument`.
 *
 * Both shapes reduce to: the assembled `SiteDocument` (shell + pages +
 * Visual Components), the user data tables and their rows, and the media
 * library — each media item with the exact public path content uses to
 * reference it and, when the source has them, a way to read its bytes.
 */

import { unzipSync, strFromU8 } from 'fflate'
import { reindexNodeParents, type SiteDocument } from '@core/page-tree'
import type { DataRow, DataTable } from '@core/data/schemas'
import { pageFromRow } from '@core/data/pageFromRow'
import { visualComponentFromRow } from '@core/data/componentFromRow'
import {
  BUNDLE_ARCHIVE_MANIFEST_PATH,
  SiteBundleArchiveManifestSchema,
  mediaArchivePath,
  type SiteBundleArchiveManifest,
} from '@core/data/bundleArchive'
import type { MediaAssetMetadata, SiteBundle } from '@core/data/bundleSchema'
import { safeParseJson } from '@core/utils/jsonValidate'

export interface FragmentSourceMedia {
  id: string
  /** The public path the site's content uses to reference this asset. */
  path: string
  filename: string
  mimeType: string
  sizeBytes?: number
  width?: number | null
  height?: number | null
  alt?: string
  /** Read the original bytes. Absent when the source cannot (a live site). */
  readBytes?: () => Uint8Array | null | Promise<Uint8Array | null>
}

export interface FragmentSource {
  site: SiteDocument
  /** Every data table the source has (system tables included). */
  tables: readonly DataTable[]
  /** Rows of the non-editor tables (posts, post types, data tables). */
  rows: readonly DataRow[]
  media: readonly FragmentSourceMedia[]
}

/** The source is missing something the extraction cannot do without. */
export class FragmentSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FragmentSourceError'
  }
}

/**
 * A live site. `site` is the editor's in-memory document; tables, rows and the
 * media library come from the CMS API (the editor store holds none of them).
 */
export function fragmentSourceFromSite(
  site: SiteDocument,
  extras: {
    tables?: readonly DataTable[]
    rows?: readonly DataRow[]
    media?: readonly FragmentSourceMedia[]
  } = {},
): FragmentSource {
  return {
    site,
    tables: extras.tables ?? [],
    rows: extras.rows ?? [],
    media: extras.media ?? [],
  }
}

type BundleLike = SiteBundleArchiveManifest | SiteBundle

/**
 * A site-transfer bundle: either the archive manifest (`.instatic/site-bundle.json`,
 * media bytes stored beside it) or the in-memory JSON form with embedded
 * `bytesBase64`. `readMediaBytes` supplies archive bytes by `storagePath`;
 * embedded bytes are read directly.
 */
export function fragmentSourceFromBundle(
  bundle: BundleLike,
  options: { readMediaBytes?: (storagePath: string) => Uint8Array | null } = {},
): FragmentSource {
  if (!bundle.site) {
    throw new FragmentSourceError('The bundle has no site shell (it was exported without "includeSite").')
  }
  const pageTableIds = new Set(bundle.tables.filter((t) => t.kind === 'page').map((t) => t.id))
  const componentTableIds = new Set(bundle.tables.filter((t) => t.kind === 'component').map((t) => t.id))
  const editorTableIds = new Set(
    bundle.tables.filter((t) => t.kind === 'page' || t.kind === 'component' || t.kind === 'layout').map((t) => t.id),
  )

  const live = bundle.rows.filter((row) => row.deletedAt === null)
  const pages = live.filter((row) => pageTableIds.has(row.tableId)).map((row) => {
    const page = pageFromRow(row)
    reindexNodeParents(page.nodes)
    return page
  })
  const visualComponents = live
    .filter((row) => componentTableIds.has(row.tableId))
    .flatMap((row) => {
      const vc = visualComponentFromRow(row)
      return vc ? [vc] : []
    })

  const site: SiteDocument = { ...bundle.site, pages, visualComponents, layouts: [] }
  const media = (bundle.media ?? []).map((asset): FragmentSourceMedia => ({
    id: asset.id,
    path: `/uploads/${asset.storagePath}`,
    filename: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    ...(asset.altText ? { alt: asset.altText } : {}),
    readBytes: () => readBundleMediaBytes(asset, options.readMediaBytes),
  }))

  return {
    site,
    tables: bundle.tables,
    rows: live.filter((row) => !editorTableIds.has(row.tableId)),
    media,
  }
}

function readBundleMediaBytes(
  asset: MediaAssetMetadata | (MediaAssetMetadata & { bytesBase64: string }),
  readMediaBytes: ((storagePath: string) => Uint8Array | null) | undefined,
): Uint8Array | null {
  if ('bytesBase64' in asset && typeof asset.bytesBase64 === 'string') {
    return decodeBase64(asset.bytesBase64)
  }
  return readMediaBytes?.(asset.storagePath) ?? null
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * A site-transfer archive (`.zip` from Export site): the manifest is validated
 * at this boundary and media bytes are read from `media/<storagePath>`.
 */
export function fragmentSourceFromBundleArchive(archive: Uint8Array): FragmentSource {
  const entries = unzipSync(archive)
  const manifestBytes = entries[BUNDLE_ARCHIVE_MANIFEST_PATH]
  if (!manifestBytes) {
    throw new FragmentSourceError(`Not a site-transfer archive: ${BUNDLE_ARCHIVE_MANIFEST_PATH} is missing.`)
  }
  const parsed = safeParseJson(strFromU8(manifestBytes), SiteBundleArchiveManifestSchema)
  if (!parsed.ok) {
    throw new FragmentSourceError(`The archive manifest is invalid: ${parsed.error.message}`)
  }
  return fragmentSourceFromBundle(parsed.value, {
    readMediaBytes: (storagePath) => entries[mediaArchivePath(storagePath)] ?? null,
  })
}
