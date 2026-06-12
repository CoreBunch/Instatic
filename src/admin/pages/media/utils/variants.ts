/**
 * Variant-picking + BlurHash helpers shared by every admin surface that
 * renders a media asset (canvas grid, viewer body, picker).
 *
 * The single rule for picking a variant: pick the smallest variant whose
 * width is greater-than-or-equal-to the target rendered width, accounting
 * for devicePixelRatio. If no variant is large enough, the LARGEST variant
 * wins — never the original. Same policy as the publisher's
 * `buildMediaSrcset` (src/modules/base/utils/mediaAttrs.ts): the original
 * may be a multi-MB PNG, and the ladder's top rung is the intrinsic-width
 * WebP, so falling back to the original buys nothing but bytes. The
 * original is used only when the asset has no variants at all.
 */
import { decode as decodeBlurHash } from 'blurhash'
import type { CmsMediaAsset, CmsMediaVariant } from '@core/persistence/cmsMedia'

/**
 * Choose the smallest variant ≥ targetWidth (in CSS pixels, scaled by DPR).
 * Returns the original `publicPath` when no variant is suitable — guarantees
 * the caller always has SOME url to display.
 */
export function pickVariantUrl(
  asset: Pick<CmsMediaAsset, 'publicPath' | 'variants'>,
  targetCssWidth: number,
): string {
  if (!asset.variants.length) return asset.publicPath
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
  const targetPx = Math.ceil(targetCssWidth * dpr)
  const sorted: CmsMediaVariant[] = [...asset.variants].sort((a, b) => a.width - b.width)
  // First variant ≥ target wins. Falls back to the largest variant (or the
  // original) when nothing's big enough — handles the "browser wants 4K,
  // we only have 1024" case gracefully.
  for (const v of sorted) {
    if (v.width >= targetPx) return v.path
  }
  // No variant is large enough → the largest variant still beats the
  // original: new ladders top at the intrinsic-width WebP (same pixels,
  // fraction of the bytes), and even legacy 2048-capped ladders trade a
  // marginal resolution shortfall for not downloading a multi-MB PNG.
  return sorted[sorted.length - 1].path
}

/**
 * Build the `srcset` attribute string from the variant ladder — variants
 * ONLY, never the original (any srcset candidate is selectable, and on a
 * high-DPI display the original would be the selected one; see
 * `buildMediaSrcset`). Returns `undefined` when there are no variants —
 * callers should omit the attribute entirely in that case.
 */
export function buildVariantSrcset(
  asset: Pick<CmsMediaAsset, 'publicPath' | 'variants'>,
): string | undefined {
  if (!asset.variants.length) return undefined
  return asset.variants
    .slice()
    .sort((a, b) => a.width - b.width)
    .map((v) => `${v.path} ${v.width}w`)
    .join(', ')
}

// ──────────────────────────────────────────────────────────────────────────
// BlurHash → data URL
// ──────────────────────────────────────────────────────────────────────────

const BLUR_PREVIEW_SIZE = 32

/**
 * In-memory cache so the same BlurHash decodes only once per session. Most
 * users see the same handful of assets across the canvas grid + picker +
 * viewer, so caching by hash string is a meaningful win.
 *
 * LRU isn't strictly needed because BlurHash strings are ~30 chars and the
 * generated data URLs are <2 KB each. A few hundred entries is fine.
 */
const blurHashCache = new Map<string, string>()

/**
 * Decode a BlurHash to a small PNG data URL suitable for use as a CSS
 * `background-image`. Returns `null` when the hash is invalid (defensive —
 * malformed rows shouldn't crash the UI).
 *
 * SSR-safe: returns null when `document` is undefined, callers should
 * tolerate that.
 */
export function blurHashToDataUrl(hash: string | null | undefined): string | null {
  if (!hash) return null
  const cached = blurHashCache.get(hash)
  if (cached) return cached
  if (typeof document === 'undefined') return null
  try {
    const pixels = decodeBlurHash(hash, BLUR_PREVIEW_SIZE, BLUR_PREVIEW_SIZE)
    const canvas = document.createElement('canvas')
    canvas.width = BLUR_PREVIEW_SIZE
    canvas.height = BLUR_PREVIEW_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const imageData = ctx.createImageData(BLUR_PREVIEW_SIZE, BLUR_PREVIEW_SIZE)
    imageData.data.set(pixels)
    ctx.putImageData(imageData, 0, 0)
    const url = canvas.toDataURL('image/png')
    blurHashCache.set(hash, url)
    return url
  } catch (err) {
    console.error('[variants] blurhash decode failed:', err)
    return null
  }
}
