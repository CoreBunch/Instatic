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
  listMediaAssets,
  restoreMediaAsset,
  softDeleteMediaAsset,
  updateMediaAssetMetadata,
  type UpdateMediaAssetMetadataInput,
} from '../../repositories/media'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'
import {
  EXTENSION_FOR_MIME,
  MAX_MEDIA_BYTES,
  acceptReplacementMedia,
  acceptUploadedMedia,
  readUploadForm,
} from './mediaUpload'
import { removeVariantFiles } from './mediaVariants'
import { dispatchDelete } from './mediaUploadDispatch'
import { materializeAssetListForClient } from '../../publish/mediaPresentation'

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

function readQueryFlag(url: URL, key: string): boolean {
  const value = url.searchParams.get(key)
  return value === '1' || value === 'true'
}

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

  const { file, altText } = await readUploadForm(req)
  if (!file) return badRequest('Missing file')

  const result = await acceptUploadedMedia(db, {
    file,
    maxBytes: MAX_MEDIA_BYTES,
    allowedMimes: MEDIA_LIBRARY_MIMES,
    role: 'original',
    uploadedByUserId: user.id,
    ...(altText !== undefined ? { altText } : {}),
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

  const { file } = await readUploadForm(req)
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

const MEDIA_ROUTES: readonly Route<[]>[] = [
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

export async function handleMediaRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, MEDIA_ROUTES)
}
