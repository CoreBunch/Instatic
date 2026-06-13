/**
 * Wire protocol for the image-variant worker pool.
 *
 * Sharp + libvips processes a typical 4 MP JPEG into the full responsive
 * ladder in ~200–500 ms of CPU. Running that on the main thread blocks every
 * visitor request and the admin API for the duration — a burst of uploads
 * was the one observable main-thread stall in the single-process model.
 * This protocol moves the CPU work into a `Bun.Worker` pool so the main
 * thread stays free for HTTP work.
 *
 * Trust boundary: same process, same source tree, structured-clone in
 * between. Both sides import this file; no TypeBox validation needed at
 * the boundary (the discriminated union is the contract).
 *
 * Bytes cross the boundary as transferable `ArrayBuffer`s — both the input
 * source bytes and each encoded WebP variant. After transfer, the sending
 * side's view of that buffer is detached, which matches the lifecycle we
 * want: once the worker owns the input bytes, the host shouldn't touch
 * them; once the host owns the variant bytes, the worker shouldn't either.
 */

interface ImageVariantBlurHashConfig {
  /** Component count along X. Encoder requires 1 <= x <= 9. */
  readonly x: number
  /** Component count along Y. Encoder requires 1 <= y <= 9. */
  readonly y: number
  /** Downsample width for the blurhash sample buffer. */
  readonly sampleWidth: number
  /** Downsample height for the blurhash sample buffer. */
  readonly sampleHeight: number
}

export interface ImageVariantJobRequest {
  readonly kind: 'image-variant-job'
  readonly correlationId: string
  /**
   * The full source bytes of the image to process. Sent as a transferable
   * `ArrayBuffer` — the host detaches its view after `postMessage`.
   */
  readonly bytes: ArrayBuffer
  /**
   * When `false`, only `metadata + blurhash` are produced and `variants`
   * comes back empty. The host sets this to `false` when a Tier-3 variant
   * delegate (Cloudflare Images / Imgix / …) is elected — in that case
   * the delegate generates variants on demand at the CDN edge, so the
   * host has no reason to spend CPU on a local ladder.
   */
  readonly generateLadder: boolean
  /** Sorted ascending. Widths >= the source width are skipped by the worker. */
  readonly targetWidths: readonly number[]
  /** WebP encoder quality (0..100). */
  readonly webpQuality: number
  readonly blurhashConfig: ImageVariantBlurHashConfig
}

/** Per-variant payload returned by a successful job. */
export interface ImageVariantPayload {
  readonly width: number
  readonly height: number
  /**
   * The encoded WebP bytes for this variant. Sent as a transferable
   * `ArrayBuffer` so the host can hand it to the storage-adapter dispatch
   * without copying.
   */
  readonly bytes: ArrayBuffer
}

export interface ImageVariantJobOk {
  readonly kind: 'image-variant-result'
  readonly correlationId: string
  readonly ok: true
  readonly width: number
  readonly height: number
  readonly blurHash: string
  readonly variants: readonly ImageVariantPayload[]
}

interface ImageVariantJobErr {
  readonly kind: 'image-variant-result'
  readonly correlationId: string
  readonly ok: false
  readonly error: string
}

export type ImageVariantJobResponse = ImageVariantJobOk | ImageVariantJobErr
