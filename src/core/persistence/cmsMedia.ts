import { safeParseJson } from '@core/utils/jsonValidate'
import { readEnvelope, assertOk } from '@core/http'
import {
  CmsMediaAssetEnvelopeSchema,
  CmsUnsplashPageEnvelopeSchema,
  CmsUnsplashStatusEnvelopeSchema,
  CmsMediaFolderEnvelopeSchema,
  CmsMediaFolderListResponseSchema,
  CmsMediaListResponseSchema,
  type CmsMediaAssetWire,
  type CmsMediaCropWire,
  type CmsUnsplashPhotoWire,
  type CmsMediaFocusWire,
  type CmsMediaFolder,
} from './responseSchemas'

/**
 * Normalized media asset — every field is non-optional. The wire shape
 * (`CmsMediaAssetWire`) marks the M2+ metadata fields optional so older
 * server responses keep validating; `normalizeCmsMediaAsset` runs at the
 * client boundary to fill defaults so consumer code can `asset.altText`
 * freely.
 */
/** Crop rectangle in 0–1 fractions of the original image. */
export type CmsMediaCrop = CmsMediaCropWire
/** Focal point in 0–1 fractions of the original image. */
export type CmsMediaFocus = CmsMediaFocusWire

export interface CmsMediaVariant {
  width: number
  height: number
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  path: string
  sizeBytes: number
}

/**
 * Client-facing media-asset shape. Intentionally a NARROWER projection of the
 * server repository's `MediaAsset` (`server/repositories/media.ts`): the
 * storage-internal fields — `storageAdapterId`, `externallyHosted`, and each
 * variant's `storagePath` / `storageAdapterId` — are deliberately omitted so
 * adapter internals never cross the wire to the browser.
 *
 * Because of that omission the two types are NOT interchangeable, so neither is
 * aliased to the other. The server type is the superset and is the single
 * source of truth for the hydrated row (one mapper, `mapMediaAssetRow`).
 * Folding both into one schema would mean a shared TypeBox schema in
 * `responseSchemas.ts` (the wire boundary) — flagged for CTO review rather than
 * forced here, since it crosses the server/client layer boundary.
 */
export interface CmsMediaAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  publicPath: string
  uploadedByUserId: string | null
  createdAt: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  dominantColor: string | null
  deletedAt: string | null
  replacedAt: string | null
  folderIds: string[]
  blurHash: string | null
  variants: CmsMediaVariant[]
  /** Applied non-destructive crop (0–1 fractions), or null for the full frame. */
  crop: CmsMediaCrop | null
  /** Editorial focal point (0–1 fractions of the original), or null for centre. */
  focus: CmsMediaFocus | null
  posterPath: string | null
}

export type { CmsMediaFolder }

export function normalizeCmsMediaAsset(wire: CmsMediaAssetWire): CmsMediaAsset {
  return {
    id: wire.id,
    filename: wire.filename,
    mimeType: wire.mimeType,
    sizeBytes: wire.sizeBytes,
    publicPath: wire.publicPath,
    uploadedByUserId: wire.uploadedByUserId,
    createdAt: wire.createdAt,
    altText: wire.altText ?? '',
    caption: wire.caption ?? '',
    title: wire.title ?? '',
    tags: wire.tags ?? [],
    width: wire.width ?? null,
    height: wire.height ?? null,
    durationMs: wire.durationMs ?? null,
    dominantColor: wire.dominantColor ?? null,
    deletedAt: wire.deletedAt ?? null,
    replacedAt: wire.replacedAt ?? null,
    folderIds: wire.folderIds ?? [],
    blurHash: wire.blurHash ?? null,
    variants: wire.variants ?? [],
    crop: wire.crop ?? null,
    focus: wire.focus ?? null,
    posterPath: wire.posterPath ?? null,
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface ClientBase {
  fetchImpl?: FetchLike
  basePath?: string
}

function resolveClient(base: ClientBase | undefined) {
  return {
    fetchImpl: base?.fetchImpl ?? globalThis.fetch.bind(globalThis),
    basePath: base?.basePath ?? '/admin/api/cms',
  }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

interface ListCmsMediaAssetsOptions extends ClientBase {
  /** `true` returns only soft-deleted assets (Trash view). */
  trash?: boolean
}

export async function listCmsMediaAssets(
  options: ListCmsMediaAssetsOptions = {},
): Promise<CmsMediaAsset[]> {
  const { fetchImpl, basePath } = resolveClient(options)
  const params = options.trash ? '?trash=1' : ''

  const res = await fetchImpl(`${basePath}/media${params}`, {
    method: 'GET',
    credentials: 'include',
  })
  await assertOk(res, `CMS media listing failed with ${res.status}`)
  // Use safeParseJson here so a malformed response degrades to an empty list
  // instead of crashing the media panel.
  const text = await res.text()
  const parsed = safeParseJson(text, CmsMediaListResponseSchema)
  if (!parsed.ok || !parsed.value.assets) return []
  return parsed.value.assets.map(normalizeCmsMediaAsset)
}

export async function uploadCmsMediaAsset(
  file: File,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const body = new FormData()
  body.set('file', file)

  const res = await fetchImpl(`${basePath}/media`, {
    method: 'POST',
    credentials: 'include',
    body,
  })
  const payload = await readEnvelope(res, CmsMediaAssetEnvelopeSchema, `CMS media upload failed with ${res.status}`)
  return normalizeCmsMediaAsset(payload.asset)
}

export interface UpdateCmsMediaAssetInput {
  filename?: string
  altText?: string
  caption?: string
  title?: string
  tags?: string[]
}

/**
 * General-purpose PATCH that accepts any subset of editable fields. The
 * one-field rename helper below stays for callers that only need that.
 */
export async function updateCmsMediaAsset(
  assetId: string,
  input: UpdateCmsMediaAssetInput,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await readEnvelope(res, CmsMediaAssetEnvelopeSchema, `CMS media update failed with ${res.status}`)
  return normalizeCmsMediaAsset(payload.asset)
}

/**
 * Set or clear (`crop: null`) the asset's non-destructive crop.
 *
 * The server rebuilds the responsive ladder from the untouched original, so
 * the returned asset carries new `width` / `height` / `variants` — callers
 * must replace their cached copy with it rather than patching fields, or the
 * grid keeps pointing at the swept-away variant files.
 */
export async function setCmsMediaAssetCrop(
  assetId: string,
  crop: CmsMediaCrop | null,
  /**
   * `undefined` leaves the focal point untouched; `null` clears it. When the
   * rectangle is unchanged the server treats this as a focus-only move and
   * skips the re-encode entirely.
   */
  focus: CmsMediaFocus | null | undefined = undefined,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}/crop`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(focus === undefined ? { crop } : { crop, focus }),
  })
  const payload = await readEnvelope(res, CmsMediaAssetEnvelopeSchema, `CMS media crop failed with ${res.status}`)
  return normalizeCmsMediaAsset(payload.asset)
}

export async function renameCmsMediaAsset(
  assetId: string,
  filename: string,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  return updateCmsMediaAsset(assetId, { filename }, options)
}

/**
 * Soft delete. Issues `DELETE /media/:id` which stamps `deleted_at` server-side
 * — the file stays on disk; restore() un-stamps; `purgeCmsMediaAsset()`
 * finishes the job.
 */
export async function deleteCmsMediaAsset(
  assetId: string,
  options: ClientBase = {},
): Promise<void> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS media delete failed with ${res.status}`)
}

export async function restoreCmsMediaAsset(
  assetId: string,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}/restore`, {
    method: 'POST',
    credentials: 'include',
  })
  const payload = await readEnvelope(res, CmsMediaAssetEnvelopeSchema, `CMS media restore failed with ${res.status}`)
  return normalizeCmsMediaAsset(payload.asset)
}

/**
 * Replace the binary backing this asset. Keeps the same `id` and `publicPath`
 * so every page tree / content entry / avatar reference continues to resolve.
 * Server-side checks (size + magic bytes) are identical to a fresh upload.
 */
export async function replaceCmsMediaAssetFile(
  assetId: string,
  file: File,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const body = new FormData()
  body.set('file', file)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}/replace`, {
    method: 'POST',
    credentials: 'include',
    body,
  })
  const payload = await readEnvelope(res, CmsMediaAssetEnvelopeSchema, `CMS media replace failed with ${res.status}`)
  return normalizeCmsMediaAsset(payload.asset)
}

/**
 * Hard delete + on-disk file removal. Server rejects the request unless the
 * asset is already soft-deleted, so the trash safety net can't be bypassed
 * by a single API call.
 */
export async function purgeCmsMediaAsset(
  assetId: string,
  options: ClientBase = {},
): Promise<void> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}?purge=1`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS media purge failed with ${res.status}`)
}

export async function setCmsMediaAssetFolders(
  assetId: string,
  input: { add?: string[]; remove?: string[] },
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}/folders`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await readEnvelope(res, CmsMediaAssetEnvelopeSchema, `CMS media folder assignment failed with ${res.status}`)
  return normalizeCmsMediaAsset(payload.asset)
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function listCmsMediaFolders(options: ClientBase = {}): Promise<CmsMediaFolder[]> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/folders`, {
    method: 'GET',
    credentials: 'include',
  })
  const payload = await readEnvelope(res, CmsMediaFolderListResponseSchema, `CMS folder listing failed with ${res.status}`)
  return payload.folders
}

export async function createCmsMediaFolder(
  input: { name: string; parentId?: string | null },
  options: ClientBase = {},
): Promise<CmsMediaFolder> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/folders`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await readEnvelope(res, CmsMediaFolderEnvelopeSchema, `CMS folder create failed with ${res.status}`)
  return payload.folder
}

export async function updateCmsMediaFolder(
  folderId: string,
  input: { name?: string; parentId?: string | null; sortOrder?: number },
  options: ClientBase = {},
): Promise<CmsMediaFolder> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = await readEnvelope(res, CmsMediaFolderEnvelopeSchema, `CMS folder update failed with ${res.status}`)
  return payload.folder
}

export async function deleteCmsMediaFolder(
  folderId: string,
  options: ClientBase = {},
): Promise<void> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/folders/${encodeURIComponent(folderId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS folder delete failed with ${res.status}`)
}

// ---------------------------------------------------------------------------
// Unsplash
// ---------------------------------------------------------------------------

/** One Unsplash photo, exactly as the server projects it. */
export type CmsUnsplashPhoto = CmsUnsplashPhotoWire

export interface CmsUnsplashPage {
  photos: CmsUnsplashPhoto[]
  hasMore: boolean
}

/**
 * Whether this installation has an Unsplash access key. The admin asks once
 * and hides the whole feature when the answer is no — an install without a
 * key should never show a button that can only fail.
 */
export async function getCmsUnsplashStatus(options: ClientBase = {}): Promise<boolean> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/unsplash`, { credentials: 'include' })
  const payload = await readEnvelope(
    res,
    CmsUnsplashStatusEnvelopeSchema,
    `Unsplash status failed with ${res.status}`,
  )
  return payload.configured
}

/**
 * One page of photos: the editorial feed when `query` is empty, search
 * results otherwise. `signal` matters here — the picker fires a request per
 * keystroke-debounce and must be able to drop the stale one.
 */
export async function listCmsUnsplashPhotos(
  query: string,
  page: number,
  signal?: AbortSignal,
  options: ClientBase = {},
): Promise<CmsUnsplashPage> {
  const { fetchImpl, basePath } = resolveClient(options)
  const params = new URLSearchParams({ page: String(page) })
  if (query) params.set('query', query)
  const res = await fetchImpl(`${basePath}/media/unsplash/photos?${params.toString()}`, {
    credentials: 'include',
    signal,
  })
  const payload = await readEnvelope(
    res,
    CmsUnsplashPageEnvelopeSchema,
    `Unsplash photos failed with ${res.status}`,
  )
  return { photos: payload.photos, hasMore: payload.hasMore }
}

/**
 * Pull one photo into the library. With `replaceAssetId` the bytes land on
 * that existing asset instead, keeping its id and public path so every page
 * already pointing at it swaps over.
 *
 * Only the photo ID crosses the wire: the server resolves the download URL
 * from Unsplash itself, so the browser never nominates what gets fetched.
 */
export async function importCmsUnsplashPhoto(
  photoId: string,
  replaceAssetId: string | null,
  options: ClientBase = {},
): Promise<CmsMediaAsset> {
  const { fetchImpl, basePath } = resolveClient(options)
  const res = await fetchImpl(`${basePath}/media/unsplash/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(replaceAssetId ? { photoId, replaceAssetId } : { photoId }),
  })
  const payload = await readEnvelope(
    res,
    CmsMediaAssetEnvelopeSchema,
    `Unsplash import failed with ${res.status}`,
  )
  return normalizeCmsMediaAsset(payload.asset)
}
