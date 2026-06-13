/**
 * Image-variant worker entry — runs inside a `Bun.Worker` spawned by
 * `imageVariantWorkerHost.ts`. The worker's job is the CPU-bound chunk of
 * the upload pipeline:
 *
 *   1. Probe intrinsic dimensions via `sharp`.
 *   2. Encode a BlurHash placeholder from a downsampled RGBA buffer.
 *   3. (Optional) Generate one WebP per configured target width below the
 *      intrinsic width, plus one at the intrinsic width (the srcset's
 *      full-quality top rung).
 *
 * Everything else — DB lookups, delegate election, storage-adapter
 * dispatch — stays on the main thread. The worker has no DB client and
 * no host APIs; its only output is the encoded bytes + metadata.
 *
 * Bytes cross the boundary via transferable `ArrayBuffer`s. See
 * `imageVariantProtocol.ts` for the wire shape.
 */

import sharp from 'sharp'
import { encode as encodeBlurHash } from 'blurhash'
import type { ImageVariantJobRequest, ImageVariantJobResponse, ImageVariantPayload } from './imageVariantProtocol'
import { toArrayBuffer } from '../../binary'

/** libwebp's hard cap on either output dimension. */
const MAX_WEBP_DIMENSION = 16383

function send(msg: ImageVariantJobResponse, transfer: ArrayBuffer[] = []): void {
  ;(self as unknown as { postMessage: (m: unknown, transfer?: ArrayBuffer[]) => void }).postMessage(msg, transfer)
}

async function handleJob(req: ImageVariantJobRequest): Promise<void> {
  try {
    const bytes = new Uint8Array(req.bytes)

    // Intrinsic dimensions. `sharp.metadata()` reads only the header so
    // it's cheap; reject anything that doesn't probe to real dimensions
    // (corrupt files, non-images that somehow slipped past the magic-byte
    // check, etc.).
    const metadata = await sharp(bytes).metadata()
    const originalWidth = metadata.width
    const originalHeight = metadata.height
    if (!originalWidth || !originalHeight) {
      send({
        kind: 'image-variant-result',
        correlationId: req.correlationId,
        ok: false,
        error: 'image has no intrinsic dimensions',
      })
      return
    }

    // BlurHash sample buffer. `fit: 'fill'` is intentional — BlurHash is
    // rendered into a container whose aspect ratio matches the FULL image
    // (because the consumer also knows `width` / `height`), so we don't
    // need aspect-preserving downsampling here. Crucially the blurhash
    // encoder requires `width * height * 4` bytes; `fit: 'inside'` would
    // silently shrink one dimension and produce a smaller buffer the
    // encoder then rejects.
    const { data: blurBytes } = await sharp(bytes)
      .resize(req.blurhashConfig.sampleWidth, req.blurhashConfig.sampleHeight, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const blurHash = encodeBlurHash(
      new Uint8ClampedArray(blurBytes.buffer, blurBytes.byteOffset, blurBytes.byteLength),
      req.blurhashConfig.sampleWidth,
      req.blurhashConfig.sampleHeight,
      req.blurhashConfig.x,
      req.blurhashConfig.y,
    )

    // Variant ladder. Skip when the host told us a Tier-3 delegate is
    // elected — the delegate generates variants on demand at the CDN
    // edge, so spending CPU on a local ladder would only race + double-
    // write.
    const variants: ImageVariantPayload[] = []
    const transfer: ArrayBuffer[] = []
    if (req.generateLadder) {
      // Target rungs below the intrinsic width (never upscale), topped by
      // one rung AT the intrinsic width: the srcset's largest candidate is
      // then a full-quality WebP, so the renderer never needs the original
      // (potentially a multi-MB PNG) as a high-DPI fallback.
      //
      // The WebP encoder refuses either OUTPUT dimension above 16383px, so
      // the ladder is clamped to the largest width whose aspect-scaled
      // height still fits — a 900x17000 screenshot encodes a clamped top
      // rung instead of throwing (which would kill the whole job and strip
      // the asset of variants, dimensions, AND BlurHash).
      //
      // Images smaller than every target width get NO variants at all: they
      // publish as plain pixel-exact `src` (a 48px pixel-art icon must not
      // be force-re-encoded to lossy WebP for zero byte savings).
      const maxSafeWidth = Math.min(
        MAX_WEBP_DIMENSION,
        Math.floor((MAX_WEBP_DIMENSION * originalWidth) / originalHeight),
      )
      const intrinsicRung = Math.min(originalWidth, maxSafeWidth)
      const subRungs = req.targetWidths.filter((w) => w < intrinsicRung)
      const widths = subRungs.length ? [...subRungs, intrinsicRung] : []
      for (const width of widths) {
        const v = await sharp(bytes)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: req.webpQuality })
          .toBuffer({ resolveWithObject: true })
        // Detach the encoded WebP bytes into a fresh ArrayBuffer so the
        // host owns them after transfer. `v.data` is a Node `Buffer` sharing
        // its underlying pool with sharp's internals — we can't safely
        // transfer that pool, so copy into clean bytes we can hand off.
        const ab = toArrayBuffer(v.data)
        variants.push({ width: v.info.width, height: v.info.height, bytes: ab })
        transfer.push(ab)
      }
    }

    send(
      {
        kind: 'image-variant-result',
        correlationId: req.correlationId,
        ok: true,
        width: originalWidth,
        height: originalHeight,
        blurHash,
        variants,
      },
      transfer,
    )
  } catch (err) {
    send({
      kind: 'image-variant-result',
      correlationId: req.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

;(self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage = (event: MessageEvent) => {
  const msg = event.data as ImageVariantJobRequest
  if (msg && msg.kind === 'image-variant-job') {
    void handleJob(msg)
  }
}
