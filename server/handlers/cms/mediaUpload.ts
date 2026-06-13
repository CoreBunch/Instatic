/**
 * Shared upload pipeline used by every endpoint that writes a media asset
 * (the media library + the avatar endpoint). Centralises:
 *
 *   - Multipart `file=` form parse
 *   - Magic-byte MIME sniffing (NEVER trust `file.type` — attacker-controlled)
 *   - Filename sanitisation (drops user-supplied extensions to prevent
 *     `.html` payloads from being served as text/html by the static handler)
 *   - Two-phase dispatch through the elected `MediaStorageAdapter`
 *     (see `./mediaUploadDispatch.ts`)
 *
 * The byte transport itself lives in `./mediaUploadExecutor.ts` — bytes
 * NEVER cross the QuickJS sandbox boundary, regardless of which adapter
 * is elected. Adapters only sign plans; the host streams.
 *
 * Callers control the policy knobs (`maxBytes`, allowed MIMEs, uploader id,
 * asset role) and consume the persisted `MediaAsset` row. Keeping the
 * byte-level checks in one place is a security-critical invariant — any
 * handler that uploads media MUST go through `acceptUploadedMedia`.
 */
import { basename } from 'node:path'
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import {
  createMediaAsset,
  getMediaAsset,
  getMediaAssetStoragePath,
  getMediaAssetVariants,
  replaceMediaAssetBinary,
  setMediaAssetVariants,
} from '../../repositories/media'
import { badRequest, jsonResponse } from '../../http'
import { processImageVariants, removeVariantFiles } from './mediaVariants'
import type { MediaAssetRole } from '@core/plugin-sdk'
import {
  buildSuggestedStoragePath,
  dispatchDelete,
  dispatchUpload,
  MediaStorageDispatchError,
} from './mediaUploadDispatch'
import { sanitizeSvgBytes } from './svgSanitize'

/**
 * Whitelist of media MIMEs we accept — keys are the canonical MIME, values
 * are the server-chosen on-disk extension. The static handler maps file
 * extension → Content-Type, so picking the extension here is what guarantees
 * the served Content-Type.
 *
 * SVG is allowed but goes through DOMPurify (SVG profile) before storage so
 * any `<script>`, foreignObject, or javascript:/data: URLs are stripped.
 * Fonts are static binaries with reliable magic bytes and no script surface.
 *
 * Notably absent: `application/pdf` (browsers may render PDFs inline with
 * embedded JS), anything HTML/CSS/JS adjacent.
 */
export const EXTENSION_FOR_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  // Web fonts — referenced from @font-face inside imported stylesheets. All
  // four formats are pure binary containers with no script surface; magic
  // bytes are reliable per the OpenType / WOFF specs.
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
} as const

type AcceptedMediaMime = keyof typeof EXTENSION_FOR_MIME

export const IMAGE_MIMES: ReadonlyArray<AcceptedMediaMime> = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]

const RESPONSIVE_VARIANT_MIMES: ReadonlySet<AcceptedMediaMime> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

function shouldProcessResponsiveVariants(mime: AcceptedMediaMime): boolean {
  return RESPONSIVE_VARIANT_MIMES.has(mime)
}

/**
 * Magic-byte signatures for each accepted MIME. Each signature is a list of
 * `(offset, byte)` constraints — the file passes the signature if every
 * constraint is satisfied. Some formats (WebP, MP4) need non-contiguous
 * checks (`RIFF....WEBP`, `....ftyp`), hence the offset list rather than a
 * single contiguous prefix match.
 */
type MagicConstraint = readonly [offset: number, byte: number]

const MEDIA_MAGIC_SIGNATURES: ReadonlyArray<{
  mime: AcceptedMediaMime
  bytes: ReadonlyArray<MagicConstraint>
}> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  { mime: 'image/png', bytes: [[0, 0x89], [1, 0x50], [2, 0x4e], [3, 0x47], [4, 0x0d], [5, 0x0a], [6, 0x1a], [7, 0x0a]] },
  // JPEG: FF D8 FF (SOI marker followed by any APPx marker)
  { mime: 'image/jpeg', bytes: [[0, 0xff], [1, 0xd8], [2, 0xff]] },
  // GIF87a / GIF89a
  { mime: 'image/gif', bytes: [[0, 0x47], [1, 0x49], [2, 0x46], [3, 0x38], [4, 0x37], [5, 0x61]] },
  { mime: 'image/gif', bytes: [[0, 0x47], [1, 0x49], [2, 0x46], [3, 0x38], [4, 0x39], [5, 0x61]] },
  // WebP: RIFF<size>WEBP — bytes 0..3 = RIFF, bytes 8..11 = WEBP
  { mime: 'image/webp', bytes: [[0, 0x52], [1, 0x49], [2, 0x46], [3, 0x46], [8, 0x57], [9, 0x45], [10, 0x42], [11, 0x50]] },
  // MP4 / ISO Base Media: `ftyp` box at offset 4..7. The first 4 bytes are
  // the box size which varies; only the type identifier matters here.
  { mime: 'video/mp4', bytes: [[4, 0x66], [5, 0x74], [6, 0x79], [7, 0x70]] },
  // WebM: EBML header 1A 45 DF A3 (also Matroska — close enough for us;
  // the content-type we serve is video/webm regardless and browsers will
  // refuse to play non-webm Matroska, which is the desired outcome).
  { mime: 'video/webm', bytes: [[0, 0x1a], [1, 0x45], [2, 0xdf], [3, 0xa3]] },

  // WOFF: 77 4F 46 46 ("wOFF") per W3C WOFF1 §3.
  { mime: 'font/woff', bytes: [[0, 0x77], [1, 0x4f], [2, 0x46], [3, 0x46]] },
  // WOFF2: 77 4F 46 32 ("wOF2") per W3C WOFF2 §3.
  { mime: 'font/woff2', bytes: [[0, 0x77], [1, 0x4f], [2, 0x46], [3, 0x32]] },
  // TTF / TrueType: 00 01 00 00 (sfnt scaler type) OR "true" / "ttcf" (rare).
  { mime: 'font/ttf', bytes: [[0, 0x00], [1, 0x01], [2, 0x00], [3, 0x00]] },
  { mime: 'font/ttf', bytes: [[0, 0x74], [1, 0x72], [2, 0x75], [3, 0x65]] }, // "true"
  // OTF / OpenType with CFF outlines: 4F 54 54 4F ("OTTO") per OpenType §6.
  { mime: 'font/otf', bytes: [[0, 0x4f], [1, 0x54], [2, 0x54], [3, 0x4f]] },
]

/**
 * SVG is text-based (XML), not a magic-byte format, so it can't be detected
 * by the binary sniffer above. Decode the first ~512 bytes as UTF-8 and look
 * for the XML prolog or a top-level `<svg` opening tag, allowing an optional
 * BOM and leading whitespace. Returns `'image/svg+xml'` when matched.
 *
 * This is intentionally lenient — the **security** boundary is the
 * subsequent DOMPurify pass (SVG profile) which strips `<script>`,
 * `<foreignObject>`, `javascript:` / `data:` URLs, and on-* handlers
 * regardless of how the file claims to be structured.
 */
function detectSvgMime(bytes: Uint8Array): AcceptedMediaMime | null {
  // Decode the first 512 bytes; bigger files just look at the prefix.
  const slice = bytes.subarray(0, Math.min(bytes.length, 512))
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })
  const head = decoder.decode(slice).trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    return 'image/svg+xml'
  }
  return null
}

function detectAcceptedMime(bytes: Uint8Array): AcceptedMediaMime | null {
  for (const sig of MEDIA_MAGIC_SIGNATURES) {
    let matches = true
    for (const [offset, expected] of sig.bytes) {
      if (offset >= bytes.length || bytes[offset] !== expected) {
        matches = false
        break
      }
    }
    if (matches) return sig.mime
  }
  // Fallback to text-based detection for SVG — checked LAST so a corrupted
  // binary file that happens to start with `<svg` can't be misidentified;
  // the binary signatures above would have matched first if the bytes were
  // actually a binary format.
  return detectSvgMime(bytes)
}

/**
 * Strip the user-supplied extension off a filename and sanitise the stem,
 * leaving only `[a-zA-Z0-9_-]`. The caller is responsible for re-attaching
 * a server-trusted extension. Returns `'upload'` for empty / all-illegal
 * stems so the storage filename is never blank.
 *
 * NOTE: dot is no longer in the allow-list. Earlier versions kept dot to
 * preserve the original extension, which let an attacker plant `.html` and
 * have the static handler serve it as `text/html`. The fix is structural:
 * never trust user-supplied extensions for an on-disk filename.
 */
function safeStorageStem(filename: string): string {
  const normalized = filename.replace(/\\/g, '/')
  const stem = basename(normalized).replace(/\.[^.]*$/, '')
  const safe = stem.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+/, '')
  return safe || 'upload'
}

export async function readUploadedFile(req: Request): Promise<File | null> {
  const body = await req.formData()
  const file = body.get('file')
  return file instanceof File ? file : null
}

interface AcceptUploadInput {
  /** Pre-extracted `File` from the multipart body. */
  file: File
  /** Hard ceiling on body size — caller picks the policy per surface. */
  maxBytes: number
  /** Subset of `EXTENSION_FOR_MIME` the caller is willing to accept. */
  allowedMimes: ReadonlyArray<AcceptedMediaMime>
  /**
   * Asset role — picked per call site so the dispatcher resolves the right
   * elected adapter ('original' for the media library, 'avatar' for the
   * avatar endpoint, 'font' for fonts).
   */
  role: MediaAssetRole
  /** User who triggered the upload; persisted on the media row. */
  uploadedByUserId: string | null
  /** Error message for the size-limit response (keeps the prose per-surface). */
  oversizedMessage: string
  /** Error message when the sniffed MIME isn't in `allowedMimes`. */
  unsupportedMessage: string
}

interface ValidatedUpload {
  bytes: Uint8Array
  detectedMime: AcceptedMediaMime
}

/**
 * Apply the size + magic-byte security layer to a multipart upload. Returns
 * either the validated bytes + sniffed MIME, or a ready-to-return `Response`
 * with the appropriate error envelope. Shared by both the create-asset and
 * replace-file flows so the byte-level checks live in exactly one place.
 */
async function validateUploadedMedia(input: AcceptUploadInput): Promise<Response | ValidatedUpload> {
  if (input.file.size <= 0) return badRequest('File is empty')
  if (input.file.size > input.maxBytes) return badRequest(input.oversizedMessage)

  // Detect MIME from the actual bytes (NEVER from `file.type`, which is
  // attacker-controlled in any non-browser HTTP client). Reject anything
  // that doesn't match a known signature OR isn't in the caller's allow-list.
  let bytes = new Uint8Array(await input.file.arrayBuffer())
  const detectedMime = detectAcceptedMime(bytes)
  if (!detectedMime || !input.allowedMimes.includes(detectedMime)) {
    return badRequest(input.unsupportedMessage)
  }

  // SVG passes the (lenient) text-based detector but still needs the script
  // surface removed before persistence — see svgSanitize.ts for the threat
  // model. Sanitize-then-store: the bytes that hit disk match the bytes the
  // browser will receive, with no out-of-band cleaning step needed.
  if (detectedMime === 'image/svg+xml') {
    const sanitized = sanitizeSvgBytes(bytes)
    if (sanitized.length === 0) {
      return badRequest('SVG file is empty after sanitisation (likely contains only disallowed elements).')
    }
    // Copy into a fresh ArrayBuffer-backed view so the type matches the
    // `Uint8Array<ArrayBuffer>` the rest of the pipeline expects (the
    // TextEncoder output is typed against the looser ArrayBufferLike).
    bytes = new Uint8Array(sanitized)
  }

  return { bytes, detectedMime }
}

/**
 * Validate + persist an uploaded image/video and return the created media row.
 *
 * On any policy failure the function returns a `Response` so the caller can
 * `return response` straight from its route handler. On success it returns
 * the `MediaAsset` row from the repository.
 *
 * The actual byte transport is handled by `dispatchUpload`: the elected
 * adapter for `input.role` signs an upload plan, the host streams bytes
 * to it directly, the adapter commits. Bytes NEVER cross the QuickJS
 * boundary.
 */
export async function acceptUploadedMedia(
  db: DbClient,
  input: AcceptUploadInput,
): Promise<Response | Awaited<ReturnType<typeof createMediaAsset>>> {
  const validated = await validateUploadedMedia(input)
  if (validated instanceof Response) return validated

  // Server-chosen extension on the on-disk filename so the static handler's
  // extension→Content-Type lookup can only ever yield the verified inert
  // MIME we just sniffed. Client-supplied extension is dropped.
  const storageName = `${safeStorageStem(input.file.name)}${EXTENSION_FOR_MIME[validated.detectedMime]}`
  const suggestedStoragePath = buildSuggestedStoragePath(safeStorageStem(input.file.name), EXTENSION_FOR_MIME[validated.detectedMime])

  let dispatched
  try {
    dispatched = await dispatchUpload(db, {
      bytes: validated.bytes,
      mimeType: validated.detectedMime,
      suggestedStoragePath,
      role: input.role,
    })
  } catch (err) {
    if (err instanceof MediaStorageDispatchError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const asset = await createMediaAsset(db, {
    id: nanoid(),
    filename: input.file.name || storageName,
    mimeType: validated.detectedMime,
    sizeBytes: input.file.size,
    storagePath: dispatched.storagePath,
    publicPath: dispatched.publicUrl,
    uploadedByUserId: input.uploadedByUserId,
    storageAdapterId: dispatched.storageAdapterId,
    externallyHosted: dispatched.externallyHosted,
  })

  // Responsive pipeline (docs/features/media.md). Raster-only for v1:
  // SVGs already scale without a bitmap ladder, and GIF conversion would
  // collapse animation to a still. Failure inside the pipeline is
  // non-fatal: the asset row is already written; the worst case is the row
  // has no variants and consumers fall back to the original. Logged at the
  // boundary in `mediaVariants.ts`.
  if (shouldProcessResponsiveVariants(validated.detectedMime)) {
    const processed = await processImageVariants(db, validated.bytes, dispatched.storagePath)
    if (processed) {
      const upgraded = await setMediaAssetVariants(db, asset.id, {
        width: processed.width,
        height: processed.height,
        blurHash: processed.blurHash,
        variants: processed.variants,
      })
      if (upgraded) return upgraded
    }
  }

  return asset
}

/**
 * Replace the binary backing an existing asset. Public URL stays stable —
 * the asset row keeps its `id` so every page tree / content entry / avatar
 * reference is automatically updated.
 *
 * Flow:
 *   1. Run the same security checks as a fresh upload (size + magic bytes).
 *   2. Look up the existing asset so we know which adapter wrote its
 *      bytes (so we delete via the right one) and its current variants.
 *   3. Dispatch the new binary write through whichever adapter is currently
 *      elected for the role — that may be different from the one that
 *      wrote the previous binary, and that's fine; the row records the
 *      new adapter id alongside the new bytes.
 *   4. Update the row (`replaceMediaAssetBinary`).
 *   5. Delete the previous bytes via the PREVIOUS adapter. Failures here
 *      are non-fatal — the replacement already succeeded; the worst case
 *      is orphaned bytes the user can sweep later.
 */
export async function acceptReplacementMedia(
  db: DbClient,
  assetId: string,
  input: AcceptUploadInput,
): Promise<Response | Awaited<ReturnType<typeof replaceMediaAssetBinary>>> {
  const validated = await validateUploadedMedia(input)
  if (validated instanceof Response) return validated

  const previous = await getMediaAsset(db, assetId)
  if (!previous) {
    return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
  }
  const previousStoragePath = await getMediaAssetStoragePath(db, assetId)
  if (!previousStoragePath) {
    return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
  }
  // Snapshot the previous responsive variants BEFORE the row update so we
  // can sweep them off the backend after the replace lands. The new
  // variant ladder is derived from the new binary's dimensions, so the
  // old files are guaranteed to be orphaned regardless of width overlap.
  const previousVariants = await getMediaAssetVariants(db, assetId)

  const storageName = `${safeStorageStem(input.file.name)}${EXTENSION_FOR_MIME[validated.detectedMime]}`
  const suggestedStoragePath = buildSuggestedStoragePath(safeStorageStem(input.file.name), EXTENSION_FOR_MIME[validated.detectedMime])

  let dispatched
  try {
    dispatched = await dispatchUpload(db, {
      bytes: validated.bytes,
      mimeType: validated.detectedMime,
      suggestedStoragePath,
      role: input.role,
    })
  } catch (err) {
    if (err instanceof MediaStorageDispatchError) {
      return jsonResponse({ error: err.message }, { status: err.status })
    }
    throw err
  }

  const updated = await replaceMediaAssetBinary(db, assetId, {
    filename: input.file.name || storageName,
    mimeType: validated.detectedMime,
    sizeBytes: input.file.size,
    storagePath: dispatched.storagePath,
    publicPath: dispatched.publicUrl,
    storageAdapterId: dispatched.storageAdapterId,
    externallyHosted: dispatched.externallyHosted,
  })
  if (!updated) {
    // The asset disappeared between the lookup and the update (race against
    // a parallel hard-delete). Clean up the bytes we just wrote so we
    // don't leak them, then 404.
    await dispatchDelete(dispatched.storageAdapterId, dispatched.storagePath).catch((err) => {
      console.error('[mediaUpload] post-race cleanup failed (orphaned bytes):', err)
    })
    return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
  }

  // Stamp the fresh responsive output, then sweep the old binary + old
  // variants off the backend. The variants step runs AFTER the row-replace
  // so a crash mid-pipeline leaves the asset with the new original but no
  // variants — consumers fall back to the original gracefully.
  let finalAsset = updated
  if (shouldProcessResponsiveVariants(validated.detectedMime)) {
    const processed = await processImageVariants(db, validated.bytes, dispatched.storagePath)
    if (processed) {
      const upgraded = await setMediaAssetVariants(db, assetId, {
        width: processed.width,
        height: processed.height,
        blurHash: processed.blurHash,
        variants: processed.variants,
      })
      if (upgraded) finalAsset = upgraded
    } else {
      // Pipeline failed but the row already carries stale width/height/
      // blur from the previous binary — clear them so consumers know there's
      // no responsive ladder for the new binary either.
      const cleared = await setMediaAssetVariants(db, assetId, {
        width: null,
        height: null,
        blurHash: null,
        variants: [],
      })
      if (cleared) finalAsset = cleared
    }
  } else {
    // Non-image replace: drop any leftover image variants/dimensions.
    const cleared = await setMediaAssetVariants(db, assetId, {
      width: null,
      height: null,
      blurHash: null,
      variants: [],
    })
    if (cleared) finalAsset = cleared
  }

  // Sweep the previous bytes via THEIR adapter (not the currently elected
  // one — the asset may have lived on a different backend before this
  // replace). Variant cleanup honours each variant's own adapter id too.
  await dispatchDelete(previous.storageAdapterId, previousStoragePath).catch((err) => {
    console.error('[mediaUpload] previous-binary cleanup failed (orphaned bytes):', err)
  })
  await removeVariantFiles(previousVariants)
  return finalAsset
}
