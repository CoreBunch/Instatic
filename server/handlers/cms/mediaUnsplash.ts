/**
 * Unsplash media endpoints.
 *
 *   GET  /admin/api/cms/media/unsplash          — { configured } so the admin
 *                                                  knows whether to offer the
 *                                                  feature at all
 *   GET  /admin/api/cms/media/unsplash/photos   — editorial feed, or search
 *                                                  results when `query` is set
 *                                                  (`page`, 1-based)
 *   POST /admin/api/cms/media/unsplash/import   — pull one photo into the
 *                                                  library; body:
 *                                                  { photoId, replaceAssetId? }
 *
 * The access key never leaves the server: the admin talks only to these
 * routes, and `unsplashClient.ts` is the only module that reads the key.
 *
 * Import takes a photo ID, never a URL. The server re-fetches the photo from
 * Unsplash and uses the download URL from *their* response, so a compromised
 * or simply creative client cannot point the importer at an arbitrary host.
 * The bytes then go through `acceptUploadedMedia` — the same sniffing, size
 * ceiling, storage dispatch, and variant ladder as a file dragged in by hand.
 * An Unsplash photo is not more trusted than a user upload.
 *
 * Capabilities: browsing is `media.read`, importing is `media.write`, and
 * importing OVER an existing asset additionally requires `media.replace` —
 * the same split the manual upload and replace endpoints already use.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readValidatedBody,
} from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CMS_API_PREFIX } from './shared'
import {
  IMAGE_MIMES,
  MAX_MEDIA_BYTES,
  acceptReplacementMedia,
  acceptUploadedMedia,
} from './mediaUpload'
import { updateMediaAssetMetadata } from '../../repositories/media'
import { downloadRemoteImage } from './remoteImageFetch'
import {
  UnsplashApiError,
  UnsplashNotConfiguredError,
  attributionCaption,
  importable,
  isUnsplashConfigured,
  listPhotos,
  searchPhotos,
} from './unsplashClient'

const UNSPLASH_PREFIX = `${CMS_API_PREFIX}/media/unsplash`

/** Unsplash caps `per_page` at 30; asking for more is silently truncated. */
const PER_PAGE = 30
const MAX_PAGE = 100
const MAX_QUERY_CHARS = 200

const ImportBodySchema = Type.Object({
  photoId: Type.String({ minLength: 1, maxLength: 128 }),
  /**
   * When present, the photo replaces this asset's binary instead of creating
   * a new one — the asset keeps its id and public path, so every page already
   * pointing at it swaps over.
   */
  replaceAssetId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
})

/** Map the client's typed failures onto HTTP without leaking the key. */
function unsplashErrorResponse(err: unknown): Response {
  if (err instanceof UnsplashNotConfiguredError) {
    return jsonResponse(
      { error: 'Unsplash is not configured. Set UNSPLASH_ACCESS_KEY and restart.' },
      { status: 501 },
    )
  }
  if (err instanceof UnsplashApiError) {
    // 401 upstream is OUR misconfiguration, not the caller's — reporting it as
    // 401 would tell the admin their session expired, which it has not.
    const status = err.status === 401 ? 502 : err.status === 403 ? 429 : 502
    return jsonResponse({ error: err.message }, { status })
  }
  console.error('[mediaUnsplash]', err)
  return jsonResponse(
    { error: getErrorMessage(err, 'Unsplash request failed') },
    { status: 502 },
  )
}

function parsePage(raw: string | null): number {
  const n = Number(raw ?? '1')
  if (!Number.isFinite(n)) return 1
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(n)))
}

async function handleStatus(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'media.read')
  if (user instanceof Response) return user
  return jsonResponse({ configured: isUnsplashConfigured() })
}

async function handlePhotos(req: Request, db: DbClient, url: URL): Promise<Response> {
  const user = await requireCapability(req, db, 'media.read')
  if (user instanceof Response) return user

  const query = (url.searchParams.get('query') ?? '').trim().slice(0, MAX_QUERY_CHARS)
  const page = parsePage(url.searchParams.get('page'))

  try {
    const result = query
      ? await searchPhotos(query, page, PER_PAGE, req.signal)
      : await listPhotos(page, PER_PAGE, req.signal)
    return jsonResponse(result)
  } catch (err) {
    return unsplashErrorResponse(err)
  }
}

async function handleImport(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'media.write')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, ImportBodySchema)
  if (!body) return badRequest('Expected { photoId } in the request body')

  // Replacing an existing asset is a strictly bigger act than adding one: it
  // rewrites bytes every published page already points at.
  if (body.replaceAssetId) {
    const replacer = await requireCapability(req, db, 'media.replace')
    if (replacer instanceof Response) return replacer
  }

  let photo
  let downloadUrl: string
  try {
    const resolved = await importable(body.photoId, req.signal)
    photo = resolved.photo
    downloadUrl = resolved.downloadUrl
  } catch (err) {
    return unsplashErrorResponse(err)
  }

  let bytes: Uint8Array<ArrayBuffer>
  try {
    bytes = await downloadRemoteImage(downloadUrl, MAX_MEDIA_BYTES, req.signal)
  } catch (err) {
    console.error('[mediaUnsplash] photo download failed:', err)
    return jsonResponse(
      { error: getErrorMessage(err, 'Could not download the photo from Unsplash') },
      { status: 502 },
    )
  }
  if (bytes.length === 0) return badRequest('Unsplash returned an empty image')

  const file = new File([bytes], `unsplash-${photo.id}.jpg`)
  const upload = {
    file,
    maxBytes: MAX_MEDIA_BYTES,
    allowedMimes: IMAGE_MIMES,
    role: 'original' as const,
    uploadedByUserId: user.id,
    oversizedMessage: 'The Unsplash photo exceeds the 50 MB hard limit',
    unsupportedMessage: 'Unsplash returned a format this library does not accept',
  }

  const result = body.replaceAssetId
    ? await acceptReplacementMedia(db, body.replaceAssetId, upload)
    : await acceptUploadedMedia(db, upload)
  if (result instanceof Response) return result
  // `acceptReplacementMedia` resolves null when the target row vanished
  // between the capability check and the write.
  if (!result) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })

  // Attribution travels WITH the asset, not just with the picker session. The
  // credit is only discoverable later if it is stored on the row.
  const described = await updateMediaAssetMetadata(db, result.id, {
    altText: photo.description || undefined,
    caption: attributionCaption(photo),
  })

  return jsonResponse(
    { asset: described ?? result },
    { status: body.replaceAssetId ? 200 : 201 },
  )
}

export async function handleUnsplashRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === UNSPLASH_PREFIX) {
    if (req.method !== 'GET') return methodNotAllowed()
    return handleStatus(req, db)
  }
  if (path === `${UNSPLASH_PREFIX}/photos`) {
    if (req.method !== 'GET') return methodNotAllowed()
    return handlePhotos(req, db, url)
  }
  if (path === `${UNSPLASH_PREFIX}/import`) {
    if (req.method !== 'POST') return methodNotAllowed()
    return handleImport(req, db)
  }
  return null
}
