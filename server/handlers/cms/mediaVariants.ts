/**
 * mediaVariants — server-side responsive image + BlurHash pipeline.
 *
 * Coordinates a single upload's variant generation:
 *
 *   1. Decide whether to run the local ladder. When a Tier-3 variant
 *      delegate (Cloudflare Images / Imgix / Bunny Optimizer / …) is
 *      elected we skip local sharp encoding entirely and emit
 *      URL-template variants pointing at the delegate's service.
 *   2. Hand the source bytes to a `Bun.Worker` (see
 *      `imageVariantWorkerHost.ts`) which probes intrinsic dimensions,
 *      encodes a BlurHash placeholder, and — when the local ladder is
 *      in use — produces one WebP per target width.
 *   3. Stream each returned variant through `dispatchUpload(role:
 *      'variant')` so plugin storage adapters receive bytes for variants
 *      the same way they do for originals.
 *
 * **Why the worker:** sharp + libvips on a typical 4 MP JPEG is ~200–500 ms
 * of CPU on the main thread, which blocks every visitor request and the
 * admin API for the duration. Offloading to a `Bun.Worker` keeps the main
 * thread free while uploads serialise inside the pool. The host is still
 * the only side with a DB client and storage-adapter access — the worker
 * just does the CPU work.
 *
 * The default local-disk adapter writes each WebP next to the original at
 * `<uploadsDir>/<originalStem>-w<width>.webp`. The dispatch step is
 * adapter-agnostic; this module never touches the filesystem directly.
 */
import type { DbClient } from '../../db/client'
import { dispatchDelete, dispatchUpload } from './mediaUploadDispatch'
import { getElectedVariantDelegate, type ElectedVariantDelegate } from '../../repositories/mediaStorageAdapters'
import { runImageVariantJob, isImageVariantOk } from './imageVariantWorkerHost'
import { toArrayBuffer } from '../../binary'

/**
 * Target widths for the responsive variant ladder. Chosen to cover the
 * common breakpoints we serve in the editor (mobile 375 / tablet 768 /
 * desktop 1024 / wide 1600+) plus a tiny 64 the admin grid uses for
 * fast-loading thumbnails, plus a 2048 high-DPI variant. The worker also
 * encodes one rung at the source's INTRINSIC width, so the srcset's top
 * candidate is always a full-quality WebP and the original never has to
 * appear in srcset (see buildMediaSrcset).
 *
 * Sorted ascending so the variant array stays small-to-large for callers
 * doing a linear "smallest >= target" pick.
 */
const TARGET_WIDTHS = [64, 320, 640, 1024, 1600, 2048] as const

/**
 * WebP encoder quality. 80 is the standard "visually lossless for
 * non-pixel-art photos" sweet spot. We don't tweak per-variant — encoding
 * cost is already the bottleneck.
 */
const WEBP_QUALITY = 80

/**
 * BlurHash component counts. (4, 3) produces a punchy ~30-character hash
 * that decodes to a recognisable placeholder without bloating the column.
 * The encoder requires the source raw RGBA in 32x32 form; we resize on the
 * fly before encoding.
 */
const BLURHASH_X_COMPONENTS = 4
const BLURHASH_Y_COMPONENTS = 3
const BLURHASH_SAMPLE_WIDTH = 32
const BLURHASH_SAMPLE_HEIGHT = 32

interface MediaVariantRecord {
  width: number
  height: number
  format: 'webp'
  path: string
  sizeBytes: number
  /** Adapter-internal storage handle — used by the delete dispatch path. */
  storagePath: string
  /** Adapter id that wrote this variant; `''` for local-disk. */
  storageAdapterId: string
}

interface ImageProcessingResult {
  width: number
  height: number
  blurHash: string
  variants: MediaVariantRecord[]
}

/**
 * Strip the WebP-friendly extension from the original storage name so the
 * variant filenames stay readable (e.g. `abc-hero.png` →
 * `abc-hero-w320.webp`, not `abc-hero.png-w320.webp`).
 */
function variantStorageBase(storagePath: string): string {
  const dot = storagePath.lastIndexOf('.')
  return dot >= 0 ? storagePath.slice(0, dot) : storagePath
}

/**
 * Generate the full responsive ladder for an uploaded raster image.
 * Returns the probed dimensions, the BlurHash placeholder, and the list of
 * variant records — each variant has been streamed to the elected
 * `'variant'` storage adapter by this point (default local-disk).
 *
 * Callers gate this to raster formats. SVGs already scale as originals;
 * animated GIFs must not be collapsed into still WebP frames. On any worker
 * failure, returns `null` so the caller falls back to a plain row with no
 * variants. Callers MUST handle the null case — the admin grid still
 * renders fine without variants, it just loads the original.
 *
 * Trust boundary: the worker probes dimensions, encodes the BlurHash, and
 * (when no delegate is elected) produces the WebP ladder bytes. The host
 * stays the sole owner of the DB client and storage-adapter dispatch.
 * Delegate election runs host-side first so the worker can skip the
 * encode entirely when a Tier-3 delegate is taking over the ladder.
 */
export async function processImageVariants(
  db: DbClient,
  bytes: Uint8Array,
  /** storagePath of the parent original — used to derive variant filenames. */
  parentStoragePath: string,
): Promise<ImageProcessingResult | null> {
  try {
    // Decide whether to spend CPU on a local ladder. A Tier-3 variant
    // delegate (Cloudflare Images / Imgix / Bunny Optimizer / …)
    // generates variants on demand at the CDN edge, so local generation
    // would race + double-write. The worker still produces metadata +
    // BlurHash in either case.
    const delegate = await getElectedVariantDelegate(db)

    // Copy the source bytes into a fresh ArrayBuffer the worker can take
    // ownership of via transfer — keeps the caller's `Uint8Array` view intact.
    const sourceBuffer = toArrayBuffer(bytes)

    const response = await runImageVariantJob({
      bytes: sourceBuffer,
      generateLadder: !delegate,
      targetWidths: TARGET_WIDTHS,
      webpQuality: WEBP_QUALITY,
      blurhashConfig: {
        x: BLURHASH_X_COMPONENTS,
        y: BLURHASH_Y_COMPONENTS,
        sampleWidth: BLURHASH_SAMPLE_WIDTH,
        sampleHeight: BLURHASH_SAMPLE_HEIGHT,
      },
    })

    if (!isImageVariantOk(response)) {
      console.error('[mediaVariants] worker failed:', response.error)
      return null
    }

    // Delegate path: variant ladder is URLs into the delegate's service,
    // not host-stored bytes. The worker returned no variant bytes for
    // this case (we passed `generateLadder: false`).
    if (delegate) {
      const variants = buildDelegateVariants(delegate, parentStoragePath, response.width, response.height)
      return {
        width: response.width,
        height: response.height,
        blurHash: response.blurHash,
        variants,
      }
    }

    // Local-ladder path: stream each WebP returned by the worker through
    // `dispatchUpload(role: 'variant')` so plugin storage adapters get
    // bytes for variants the same way they do for originals.
    const base = variantStorageBase(parentStoragePath)
    const variants: MediaVariantRecord[] = []
    for (const v of response.variants) {
      const suggested = `${base}-w${v.width}.webp`
      const variantBytes = new Uint8Array(v.bytes)
      const dispatched = await dispatchUpload(db, {
        bytes: variantBytes,
        mimeType: 'image/webp',
        suggestedStoragePath: suggested,
        role: 'variant',
        variantOf: parentStoragePath,
      })
      variants.push({
        width: v.width,
        height: v.height,
        format: 'webp',
        path: dispatched.publicUrl,
        sizeBytes: variantBytes.byteLength,
        storagePath: dispatched.storagePath,
        storageAdapterId: dispatched.storageAdapterId,
      })
    }

    return {
      width: response.width,
      height: response.height,
      blurHash: response.blurHash,
      variants,
    }
  } catch (err) {
    console.error('[mediaVariants] image processing failed:', err)
    return null
  }
}

/**
 * Compute the original public path the delegate template targets. Locally-
 * hosted originals live at `/uploads/<storagePath>`; the delegate's URL
 * template substitutes `{path}` with this value to construct the variant
 * URL. For externally-hosted originals the absolute URL would be the
 * proper substitution, but the variant pipeline doesn't currently know
 * the original's `public_path` — passing `/uploads/<storage>` is the
 * conservative choice that matches what the host's static handler serves.
 */
function originPathForDelegate(parentStoragePath: string): string {
  return parentStoragePath.startsWith('/')
    ? parentStoragePath
    : `/uploads/${parentStoragePath}`
}

/**
 * Substitute the delegate's URL template placeholders. The template is
 * declared once at plugin registration and is the same for every variant
 * (only width / format / quality / path vary), so this is a cheap string
 * replace — no JIT, no eval.
 *
 * Supported placeholders: `{path}`, `{width}`, `{format}`, `{quality}`,
 * `{originalMime}` (matches the SDK's `MediaVariantDelegate` JSDoc).
 */
function fillDelegateTemplate(
  template: string,
  vars: { path: string; width: number; format: string; quality: number; originalMime: string },
): string {
  return template
    .replaceAll('{path}', vars.path)
    .replaceAll('{width}', String(vars.width))
    .replaceAll('{format}', vars.format)
    .replaceAll('{quality}', String(vars.quality))
    .replaceAll('{originalMime}', vars.originalMime)
}

/**
 * Materialise the delegate's variant ladder. `sizeBytes` is `0` for every
 * entry because we never produced the bytes — the delegate generates the
 * variant on demand at the CDN edge. Consumers that depend on
 * `sizeBytes` for prefetch budgeting will treat a `0` as "unknown" (the
 * UI already does for non-image MIMEs).
 */
function buildDelegateVariants(
  delegate: ElectedVariantDelegate,
  parentStoragePath: string,
  originalWidth: number,
  originalHeight: number,
): MediaVariantRecord[] {
  const aspect = originalHeight > 0 ? originalHeight / originalWidth : 1
  // The variant ladder is one entry per (width, format) pair — but we
  // only emit ONE format per width to keep `srcset` lean. Picking the
  // first declared format (typically 'webp' or 'avif') matches the
  // strategy of every image-CDN: serve the modern format unless the
  // browser explicitly opts out via Accept headers.
  const format = delegate.formats[0] ?? 'webp'
  const path = originPathForDelegate(parentStoragePath)
  const out: MediaVariantRecord[] = []
  // Declared widths below intrinsic ONLY — no host-synthesized intrinsic
  // rung here, unlike the local worker. The plugin's `widths` array is a
  // contract ("widths the renderer should emit in srcset", schema-bounded
  // to 16..8192): minting an undeclared probed width could exceed the
  // service's allowlist or output cap and put a broken URL at the TOP of
  // the srcset. The original is excluded from srcset by buildMediaSrcset
  // regardless, so the largest declared rung is the delegate's ceiling.
  for (const width of delegate.widths) {
    if (width >= originalWidth) continue
    const url = fillDelegateTemplate(delegate.variantUrlTemplate, {
      path,
      width,
      format,
      quality: 80,
      originalMime: 'image/jpeg',
    })
    out.push({
      width,
      height: Math.round(width * aspect),
      // The format literal is widened to `'webp'` because the on-disk
      // emitter only ever wrote webp; the SDK shape accepts `webp | jpeg
      // | avif`, and storing the actual delegate format keeps the
      // renderer's `<picture>` emission honest.
      format: format as 'webp',
      path: url,
      sizeBytes: 0,
      // Variants emitted by the delegate aren't backed by host-stored
      // bytes — they live entirely on the delegate's CDN. We label them
      // with the delegate id so the delete path knows they're virtual
      // (and the prefix `delegate:` keeps the field's "namespaced adapter
      // id" semantics intact).
      storagePath: `delegate:${delegate.delegateId}`,
      storageAdapterId: `delegate:${delegate.delegateId}`,
    })
  }
  return out
}

/**
 * Remove the underlying bytes for every variant in `variants` via the
 * adapter that wrote each one. Variants written by an adapter that's
 * since been disabled are logged and skipped — bytes remain in the
 * backend (the user can clean them up out-of-band or wait for a future
 * orphan-sweep job).
 *
 * Failures are non-fatal — the database row removal has already succeeded.
 * Orphaned files just sit in the backend until a future GC sweeps them.
 */
export async function removeVariantFiles(
  variants: ReadonlyArray<{ storagePath: string; storageAdapterId: string }>,
): Promise<void> {
  for (const variant of variants) {
    // Virtual variants emitted by a Tier-3 delegate (Cloudflare Images
    // etc.) aren't backed by host-stored bytes — the delegate generates
    // them on demand at the CDN edge — so there's nothing to delete.
    // Their storage_adapter_id carries the `delegate:` prefix as a tag.
    if (variant.storageAdapterId.startsWith('delegate:')) continue
    try {
      await dispatchDelete(variant.storageAdapterId, variant.storagePath)
    } catch (err) {
      console.error('[mediaVariants] variant delete failed (orphaned bytes):', err)
    }
  }
}
