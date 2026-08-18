/**
 * Image-variant worker pool — end-to-end test.
 *
 * Spawns the real `Bun.Worker`, sends a real image through the protocol,
 * and asserts the worker probes metadata, encodes a BlurHash, and produces
 * one variant per target width smaller than the source. The point of this
 * test is to gate the worker round-trip itself — `mediaVariants.ts` is
 * already covered by `cmsMedia.test.ts` for the upload pipeline.
 *
 * The test fixture is built with the sharp instance on the test thread,
 * NOT through the worker — sharp on the main thread is fine in test code,
 * just not in the production hot path.
 */

import { describe, expect, it } from 'bun:test'
import sharp from 'sharp'
import {
  isImageVariantOk,
  runImageVariantJob,
} from '../../../server/handlers/cms/imageVariantWorkerHost'

async function fixturePng(width: number, height: number): Promise<ArrayBuffer> {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 100, b: 50, alpha: 1 },
    },
  }).png().toBuffer()
  // Slice into a fresh ArrayBuffer so the worker takes a clean transferable.
  const ab = new ArrayBuffer(buf.byteLength)
  new Uint8Array(ab).set(buf)
  return ab
}

describe('image-variant worker pool', () => {
  it('returns metadata + BlurHash + variants for a large image', async () => {
    const bytes = await fixturePng(800, 400)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: true,
      targetWidths: [64, 320, 640, 1024],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return

    expect(response.width).toBe(800)
    expect(response.height).toBe(400)
    // BlurHash is ~30 chars; we don't lock the exact value because the
    // encoder isn't deterministic across libvips versions for the same
    // input, but length + non-empty is enough to gate the round-trip.
    expect(response.blurHash.length).toBeGreaterThan(10)
    // 64, 320, 640 are < 800; 1024 is skipped (>= source width); a final
    // rung is encoded at the source's intrinsic width so the srcset's top
    // candidate is a full-quality WebP — the renderer never has to fall
    // back to the (potentially multi-MB) original for high-DPI displays.
    expect(response.variants.map((v) => v.width)).toEqual([64, 320, 640, 800])
    const intrinsic = response.variants[response.variants.length - 1]
    expect(intrinsic.height).toBe(400)
    for (const variant of response.variants) {
      expect(variant.bytes.byteLength).toBeGreaterThan(0)
      // Each variant is a fresh ArrayBuffer the host now owns.
      expect(variant.bytes).toBeInstanceOf(ArrayBuffer)
    }
  })

  it('emits exactly one rung when the source width equals a target width', async () => {
    const bytes = await fixturePng(640, 320)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: true,
      targetWidths: [64, 320, 640, 1024],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return
    // 640 is skipped as a target (>= source) but comes back once as the
    // intrinsic rung — never duplicated.
    expect(response.variants.map((v) => v.width)).toEqual([64, 320, 640])
  })

  it('clamps the intrinsic rung to the WebP 16383px dimension cap (tall screenshot)', async () => {
    // A 100x17000 strip: sub-intrinsic rungs encode fine, but a WebP at the
    // full intrinsic size is impossible (height > 16383). The rung must be
    // clamped — one impossible rung must never kill the whole job.
    const bytes = await fixturePng(100, 17000)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: true,
      targetWidths: [64, 320, 640, 1024],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return
    expect(response.width).toBe(100)
    expect(response.height).toBe(17000)
    expect(response.blurHash.length).toBeGreaterThan(10)
    // floor(16383 * 100 / 17000) = 96 — the largest width whose scaled
    // height still fits the encoder.
    expect(response.variants.map((v) => v.width)).toEqual([64, 96])
    expect(response.variants[1].height).toBeLessThanOrEqual(16383)
  })

  it('emits NO variants for an image smaller than every target width', async () => {
    // A 40px icon publishes as plain pixel-exact `src` — force-re-encoding
    // it to lossy WebP would smear pixel art for zero byte savings.
    const bytes = await fixturePng(40, 20)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: true,
      targetWidths: [64, 320, 640],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return
    expect(response.variants).toEqual([])
  })

  it('skips the ladder when generateLadder is false (delegate path)', async () => {
    const bytes = await fixturePng(800, 400)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: false,
      targetWidths: [64, 320, 640],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return
    // Metadata + BlurHash still produced — those are cheap and always
    // needed (the delegate doesn't supply a BlurHash placeholder, the
    // host needs one for the row).
    expect(response.width).toBe(800)
    expect(response.height).toBe(400)
    expect(response.blurHash.length).toBeGreaterThan(10)
    // But no variant bytes — the delegate will materialise variants on
    // demand at the CDN edge.
    expect(response.variants).toEqual([])
  })

  it('reports failure for non-image bytes', async () => {
    const ab = new ArrayBuffer(16)
    new Uint8Array(ab).set(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    const response = await runImageVariantJob({
      bytes: ab,
      generateLadder: true,
      targetWidths: [64],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(typeof response.error).toBe('string')
    expect(response.error.length).toBeGreaterThan(0)
  })
})

describe('image-variant worker — non-destructive crop', () => {
  it('extracts the crop before probing, blurring, and laddering', async () => {
    const bytes = await fixturePng(800, 400)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: true,
      // Middle half horizontally, top half vertically → 400x200.
      crop: { x: 0.25, y: 0, width: 0.5, height: 0.5 },
      targetWidths: [64, 320, 640, 1024],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return

    // Reported dimensions describe the CROPPED frame — this is what the asset
    // row stores, so `width`/`height` on the published <img> stay honest.
    expect(response.width).toBe(400)
    expect(response.height).toBe(200)
    // The ladder is built from the cropped frame too: 640/1024 now exceed the
    // source width and drop out, leaving the intrinsic rung at 400.
    expect(response.variants.map((v) => v.width)).toEqual([64, 320, 400])
    expect(response.variants[response.variants.length - 1].height).toBe(200)
  })

  it('returns a cropped served file in the source format when asked', async () => {
    const bytes = await fixturePng(800, 400)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: false,
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
      emitCropped: true,
      targetWidths: [],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return

    // Without this file the crop would live only inside the srcset ladder, and
    // any consumer reading the served file directly (plain `src`, OG tags, the
    // admin grid) would show uncropped pixels.
    expect(response.cropped).toBeDefined()
    expect(response.cropped!.width).toBe(400)
    expect(response.cropped!.height).toBe(400)
    // Source was a PNG, so the served copy stays a PNG — the asset row's
    // mime_type must keep describing its own bytes.
    expect(response.cropped!.mimeType).toBe('image/png')
    expect(response.cropped!.extension).toBe('png')
    const probed = await sharp(Buffer.from(response.cropped!.bytes)).metadata()
    expect(probed.width).toBe(400)
    expect(probed.height).toBe(400)
  })

  it('omits the served copy when no crop is applied', async () => {
    const bytes = await fixturePng(400, 200)
    const response = await runImageVariantJob({
      bytes,
      generateLadder: false,
      emitCropped: true,
      targetWidths: [],
      webpQuality: 80,
      blurhashConfig: { x: 4, y: 3, sampleWidth: 32, sampleHeight: 32 },
    })

    expect(isImageVariantOk(response)).toBe(true)
    if (!isImageVariantOk(response)) return
    expect(response.cropped).toBeUndefined()
  })
})
