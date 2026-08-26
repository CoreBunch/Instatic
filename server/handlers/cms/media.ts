/**
 * Media library endpoints — capabilities split per-operation.
 *
 *   GET    /admin/api/cms/media                — list every uploaded asset
 *                                                  (?trash=1 → trashed items only)
 *                                                  (`media.read`)
 *   POST   /admin/api/cms/media                — upload a new image/video
 *                                                  (multipart `file=`, max 50MB)
 *                                                  (`media.write`)
 *   PATCH  /admin/api/cms/media/:id            — rename / edit metadata
 *                                                  (`media.write`)
 *   DELETE /admin/api/cms/media/:id            — soft delete by default,
 *                                                  ?purge=1 hard-deletes (only
 *                                                  permitted on already-trashed
 *                                                  assets) and removes the file
 *                                                  (`media.delete`)
 *   POST   /admin/api/cms/media/:id/restore    — restore a soft-deleted asset
 *                                                  (`media.write`)
 *   POST   /admin/api/cms/media/:id/replace    — overwrite the bytes for an asset
 *                                                  (`media.replace` — uniquely
 *                                                  dangerous: silently swaps the
 *                                                  bytes every page references)
 *   POST   /admin/api/cms/media/:id/folders    — add/remove folder memberships
 *                                                  body: { add?: string[], remove?: string[] }
 *                                                  (`media.write`)
 *   PUT    /admin/api/cms/media/:id/crop       — set/clear the non-destructive
 *                                                  crop; body: { crop: rect|null }
 *                                                  in 0–1 fractions. Rebuilds the
 *                                                  variant ladder from the
 *                                                  untouched original, so it is
 *                                                  reversible (`media.write`)
 *
 * The upload pipeline (multipart parse, magic-byte MIME sniff, sanitised
 * on-disk filename, media row insert) lives in `./mediaUpload.ts` and is
 * shared with the avatar endpoint in `./me.ts`. Anything that writes to
 * `uploads/` MUST go through `acceptUploadedMedia` so the byte-level checks
 * stay in one place.
 *
 * Dispatch shape: a flat `MEDIA_ROUTES` table maps `(method, pattern)` to a
 * per-route async handler and is run through the shared `runRouteTable`
 * dispatcher (`./routeTable.ts`). Adding a new media endpoint is "new handler
 * function + one row in `MEDIA_ROUTES`", not "edit a giant if/else chain".
 * Parameterised paths use a `RegExp` pattern with a named `id` capture group.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import {
  assignAssetToFolders,
  deleteMediaAsset,
  getMediaAsset,
  getMediaAssetStoragePath,
  getMediaAssetVariants,
  listMediaAssets,
  restoreMediaAsset,
  setMediaAssetCrop,
  setMediaAssetFocus,
  setMediaAssetVariants,
  softDeleteMediaAsset,
  updateMediaAssetMetadata,
  type MediaCrop,
  type MediaFocus,
  type UpdateMediaAssetMetadataInput,
} from '../../repositories/media'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'
import {
  EXTENSION_FOR_MIME,
  MAX_MEDIA_BYTES,
  acceptReplacementMedia,
  acceptUploadedMedia,
  readUploadedFile,
} from './mediaUpload'
import { processImageVariants, removeVariantFiles } from './mediaVariants'
import { dispatchDelete } from './mediaUploadDispatch'
import { materializeAssetListForClient } from '../../publish/mediaPresentation'
import { join } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'

const MEDIA_LIBRARY_MIMES = Object.keys(EXTENSION_FOR_MIME) as Array<
  keyof typeof EXTENSION_FOR_MIME
>

const MEDIA_PREFIX = `${CMS_API_PREFIX}/media`

function notFound(): Response {
  return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
}

function readLimit(url: URL): number | null {
  const param = url.searchParams.get('limit')
  if (!param) return null
  return Math.min(Math.max(parseInt(param, 10) || 25, 1), 100)
}

/** Rectangle equality within the precision the UI can express (4 decimals). */
function sameRect(a: MediaCrop | null, b: MediaCrop | null): boolean {
  if (a === null || b === null) return a === b
  return (['x', 'y', 'width', 'height'] as const).every(
    (key) => Math.abs(a[key] - b[key]) < 0.0001,
  )
}

function readQueryFlag(url: URL, key: string): boolean {
  const value = url.searchParams.get(key)
  return value === '1' || value === 'true'
}

/**
 * Crop rectangle in 0–1 fractions of the original. `null` clears the crop and
 * regenerates the full frame — the reason the whole feature is reversible.
 */
const CropRectSchema = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
  width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
})

/**
 * Focus ellipse in 0–1 fractions of the original; null = centre. `x`/`y` are
 * the centre, `width`/`height` the full extent. The centre becomes
 * `object-position`; the extent records how much of the frame the subject
 * occupies.
 */
const FocusAreaSchema = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
  width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
})

const SetMediaCropBodySchema = Type.Object({
  crop: Type.Union([CropRectSchema, Type.Null()]),
  /**
   * Omitted = leave the focal point alone. Present = set or clear it in the
   * same request, so dragging both in one dialog is one round trip.
   */
  focus: Type.Optional(Type.Union([FocusAreaSchema, Type.Null()])),
})

const UpdateMediaMetadataBodySchema = Type.Object({
  filename: Type.Optional(Type.String()),
  altText: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
})

function buildMetadataPatch(body: { filename?: string; altText?: string; caption?: string; title?: string; tags?: string[] }): UpdateMediaAssetMetadataInput | Response {
  // PATCH accepts any subset of:
  //   filename, altText, caption, title, tags (string[])
  // Filename keeps the historical contract: when present-but-empty, that's
  // a 400. Other fields tolerate empty strings (clearing alt-text / caption
  // is a real operation).
  const patch: UpdateMediaAssetMetadataInput = {}
  if (body.filename !== undefined) {
    const filename = body.filename.trim()
    if (!filename) return badRequest('Filename is required')
    patch.filename = filename
  }
  if (body.altText !== undefined) patch.altText = body.altText
  if (body.caption !== undefined) patch.caption = body.caption
  if (body.title !== undefined) patch.title = body.title
  if (body.tags !== undefined) patch.tags = body.tags
  return patch
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-route handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleListMedia(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'media.read')
  if (user instanceof Response) return user

  const url = new URL(req.url)
  const trash = readQueryFlag(url, 'trash')
  const query = url.searchParams.get('query')?.trim().toLowerCase() ?? ''
  const limit = readLimit(url)

  let assets = await listMediaAssets(db, { includeDeleted: trash })

  // JS-side text filter (follows the intentional design of this repo — see
  // listMediaAssets comment about JS-side filtering for small media libraries).
  if (query) {
    assets = assets.filter(
      (a) =>
        a.filename.toLowerCase().includes(query) ||
        (a.title && a.title.toLowerCase().includes(query)),
    )
  }

  if (limit !== null) assets = assets.slice(0, limit)

  // Run the `media.url.transform` filter chain so the admin grid + picker
  // show identical URLs to the published page (no dev/prod skew when a
  // CDN URL transformer is registered).
  const materialized = await materializeAssetListForClient(assets)
  return jsonResponse({ assets: materialized })
}

async function handleUploadMedia(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const file = await readUploadedFile(req)
  if (!file) return badRequest('Missing file')

  const result = await acceptUploadedMedia(db, {
    file,
    maxBytes: MAX_MEDIA_BYTES,
    allowedMimes: MEDIA_LIBRARY_MIMES,
    role: 'original',
    uploadedByUserId: user.id,
    oversizedMessage: 'File exceeds the 50 MB hard limit',
    unsupportedMessage: 'Only JPEG, PNG, GIF, WebP, SVG, MP4, WebM, and web font (WOFF, WOFF2, TTF, OTF) files can be uploaded',
  })
  if (result instanceof Response) return result
  return jsonResponse({ asset: result }, { status: 201 })
}

async function handleRestoreMedia(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const restored = await restoreMediaAsset(db, params.id)
  if (!restored) return notFound()
  return jsonResponse({ asset: restored })
}

async function handleReplaceMedia(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  // `media.replace` is split out of `media.write` — uniquely dangerous
  // because it silently swaps the bytes for every page that references
  // this asset (variants regenerate too).
  const user = await requireCapability(req, db, 'media.replace')
  if (user instanceof Response) return user

  const file = await readUploadedFile(req)
  if (!file) return badRequest('Missing file')

  const result = await acceptReplacementMedia(db, params.id, {
    file,
    maxBytes: MAX_MEDIA_BYTES,
    allowedMimes: MEDIA_LIBRARY_MIMES,
    role: 'original',
    uploadedByUserId: user.id,
    oversizedMessage: 'File exceeds the 50 MB hard limit',
    unsupportedMessage: 'Only JPEG, PNG, GIF, WebP, SVG, MP4, WebM, and web font (WOFF, WOFF2, TTF, OTF) files can be uploaded',
  })
  if (result instanceof Response) return result
  return jsonResponse({ asset: result })
}

async function handleAssignMediaFolders(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const AssignFoldersBodySchema = Type.Object({
    add: Type.Optional(Type.Array(Type.String())),
    remove: Type.Optional(Type.Array(Type.String())),
  })
  const body = await readValidatedBody(req, AssignFoldersBodySchema)
  if (!body) return badRequest('Invalid request body')
  const add = body.add ?? []
  const remove = body.remove ?? []
  if (add.length === 0 && remove.length === 0) {
    return badRequest('Provide `add` or `remove` folder ids')
  }
  const asset = await assignAssetToFolders(db, params.id, { add, remove })
  if (!asset) return notFound()
  return jsonResponse({ asset })
}

async function handleUpdateMediaMetadata(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, UpdateMediaMetadataBodySchema)
  if (!body) return badRequest('Invalid request body')
  const patch = buildMetadataPatch(body)
  if (patch instanceof Response) return patch
  if (Object.keys(patch).length === 0) return badRequest('No editable fields supplied')

  const asset = await updateMediaAssetMetadata(db, params.id, patch)
  if (!asset) return notFound()
  return jsonResponse({ asset })
}

/**
 * Set (or clear, with `crop: null`) an asset's crop rectangle.
 *
 * Non-destructive by construction: the original bytes are read, never
 * rewritten. The crop is baked into a freshly generated variant ladder whose
 * filenames carry a crop-derived tag, so:
 *   - published pages pointing at the previous ladder keep resolving until
 *     they are republished (no half-cropped page mid-flight), and
 *   - `crop: null` regenerates the untagged ladder — the full frame is back.
 *
 * The previous ladder is swept only AFTER the row update lands, so a crash
 * mid-pipeline leaves an asset with working files rather than dead links.
 *
 * `media.write`, not `media.replace`: the original is untouched and the
 * operation is reversible, which is precisely what `media.replace` is not.
 */
async function handleSetMediaCrop(
  req: Request,
  db: DbClient,
  params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, SetMediaCropBodySchema)
  if (!body) return badRequest('Invalid request body')

  const crop: MediaCrop | null = body.crop
  if (crop && (crop.x + crop.width > 1.0001 || crop.y + crop.height > 1.0001)) {
    return badRequest('Crop rectangle must stay inside the image')
  }

  const asset = await getMediaAsset(db, params.id)
  if (!asset) return notFound()

  // Moving only the focal point changes no pixels: the served file and the
  // whole variant ladder stay valid, so it is one cheap UPDATE instead of a
  // re-encode. `sameRect` is the entire difference between the two paths, and
  // it also means a focus drag works on assets cropping itself would refuse
  // (GIF, SVG, externally hosted) — nothing is re-encoded for them either.
  const focus: MediaFocus | null | undefined = body.focus
  if (sameRect(asset.crop, crop) && focus !== undefined) {
    const moved = await setMediaAssetFocus(db, params.id, focus)
    if (!moved) return notFound()
    return jsonResponse({ asset: moved })
  }

  // GIF is excluded for the same reason the upload pipeline refuses to build a
  // WebP ladder for it: re-encoding collapses an animation into a still frame.
  // SVG has no raster ladder to rebuild in the first place.
  if (
    !asset.mimeType.startsWith('image/') ||
    asset.mimeType === 'image/svg+xml' ||
    asset.mimeType === 'image/gif'
  ) {
    return badRequest('Only still raster images (JPEG, PNG, WebP) can be cropped')
  }
  if (asset.externallyHosted) {
    return jsonResponse(
      { error: 'Cropping is not supported for assets stored outside this server yet.' },
      { status: 409 },
    )
  }
  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Server has no uploads directory configured' }, { status: 500 })
  }

  const storagePath = await getMediaAssetStoragePath(db, params.id)
  if (!storagePath) return notFound()

  // `storage_path` is server-written, but reading it back off disk is exactly
  // the spot where a traversal would pay off — so the composed path goes
  // through the same containment guard as every other untrusted-path sink.
  const originalPath = join(options.uploadsDir, storagePath)
  try {
    assertPathWithin(options.uploadsDir, originalPath)
  } catch {
    return badRequest('Media asset path is invalid')
  }

  const file = Bun.file(originalPath)
  if (!(await file.exists())) {
    return jsonResponse({ error: 'Original image is missing from storage' }, { status: 409 })
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Reset restores these — the row's current values describe the crop that is
  // being replaced, not the upload.
  const originalBytes = bytes.byteLength
  const originalMimeType = file.type || asset.mimeType

  const previousVariants = await getMediaAssetVariants(db, params.id)
  // The file the asset currently serves. When it isn't the pristine original
  // it is a previous crop's derivative, and becomes garbage once this one
  // lands — remembered here so it can be swept after the row update.
  const originalPublicPath = `/uploads/${storagePath}`
  // Same derivation the variant mapper documents as canonical for local rows:
  // a locally-served file's storage path is its public path minus `/uploads/`.
  const previousDisplayPath =
    asset.publicPath !== originalPublicPath && asset.publicPath.startsWith('/uploads/')
      ? asset.publicPath.slice('/uploads/'.length)
      : null

  const processed = await processImageVariants(db, bytes, storagePath, {
    crop,
    emitCroppedDisplay: true,
  })
  if (!processed) {
    return jsonResponse({ error: 'Could not process the image for cropping' }, { status: 422 })
  }

  const withVariants = await setMediaAssetVariants(db, params.id, {
    width: processed.width,
    height: processed.height,
    blurHash: processed.blurHash,
    variants: processed.variants,
  })
  if (!withVariants) return notFound()

  // A cleared crop serves the pristine original again; a set crop serves the
  // derivative the pipeline just wrote. `processed.croppedDisplay` is absent
  // exactly when `crop` is null, so the two cases can't get crossed.
  const display = processed.croppedDisplay ?? {
    publicPath: originalPublicPath,
    sizeBytes: originalBytes,
    mimeType: originalMimeType,
  }
  const updated = await setMediaAssetCrop(
    db,
    params.id,
    crop,
    display,
    // An omitted focus keeps whatever the asset had; an explicit null clears it.
    focus === undefined ? asset.focus : focus,
  )
  if (!updated) return notFound()

  await removeVariantFiles(previousVariants)
  if (previousDisplayPath) {
    await dispatchDelete(asset.storageAdapterId, previousDisplayPath).catch((err) => {
      console.error('[media] could not sweep the previous cropped file:', err)
    })
  }

  return jsonResponse({ asset: updated })
}

async function handleDeleteMedia(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'media.delete')
  if (user instanceof Response) return user

  const url = new URL(req.url)
  const purge = readQueryFlag(url, 'purge')

  if (!purge) {
    const asset = await softDeleteMediaAsset(db, params.id)
    if (!asset) return notFound()
    return jsonResponse({ asset })
  }

  // Hard delete — only legal on already-trashed assets so a single
  // click can't bypass the trash safety net. Caller must explicitly
  // soft-delete first and then purge from the Trash view.
  const existing = await getMediaAsset(db, params.id)
  if (!existing) return notFound()
  if (!existing.deletedAt) return badRequest('Asset must be soft-deleted before purge')

  // Snapshot the variant list BEFORE the row delete so we know which
  // extra bytes to sweep from each variant's adapter alongside the original.
  const variants = existing.variants
  const adapterId = existing.storageAdapterId
  const deleted = await deleteMediaAsset(db, params.id)
  if (!deleted) return notFound()

  await dispatchDelete(adapterId, deleted.storagePath).catch((err) => {
    console.error('[media] hard-delete original byte sweep failed (orphaned bytes):', err)
  })
  await removeVariantFiles(variants)
  return jsonResponse({ ok: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// Route table + dispatcher
// ─────────────────────────────────────────────────────────────────────────────

const ID_PATTERN = '(?<id>[^/]+)'

const MEDIA_ROUTES: readonly Route<[CmsHandlerOptions]>[] = [
  { method: 'GET', pattern: MEDIA_PREFIX, handler: handleListMedia },
  { method: 'POST', pattern: MEDIA_PREFIX, handler: handleUploadMedia },
  {
    method: 'POST',
    pattern: new RegExp(`^${MEDIA_PREFIX}/${ID_PATTERN}/restore$`),
    handler: handleRestoreMedia,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${MEDIA_PREFIX}/${ID_PATTERN}/replace$`),
    handler: handleReplaceMedia,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^${MEDIA_PREFIX}/${ID_PATTERN}/folders$`),
    handler: handleAssignMediaFolders,
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^${MEDIA_PREFIX}/${ID_PATTERN}/crop$`),
    handler: handleSetMediaCrop,
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^${MEDIA_PREFIX}/${ID_PATTERN}$`),
    handler: handleUpdateMediaMetadata,
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${MEDIA_PREFIX}/${ID_PATTERN}$`),
    handler: handleDeleteMedia,
  },
]

export async function handleMediaRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  return runRouteTable(req, db, MEDIA_ROUTES, options)
}
