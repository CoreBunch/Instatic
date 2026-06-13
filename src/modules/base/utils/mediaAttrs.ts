/**
 * Shared media-attribute builders for base module render() functions.
 *
 * The image module and the video module's YouTube poster both emit a
 * responsive `srcset` from the same variant-ladder shape (`RenderResolvedMedia`),
 * and both pick a single poster/preview URL from that ladder. The logic is
 * byte-identical, so it lives here once instead of being copied per module.
 *
 * Every URL produced here is run through the canonical `safeUrl` (HTML-escape
 * + scheme sanitisation) so the result is safe to drop straight into an HTML
 * attribute.
 */
import type { RenderResolvedMedia } from '@core/publisher'
import { safeUrl } from '@modules/base/utils/escape'

/**
 * Build a `srcset` attribute from a variant ladder. Returns `null` when the
 * asset has no variants.
 *
 * The ORIGINAL file is deliberately excluded: every srcset candidate is
 * selectable, and the original may be a multi-MB unoptimized PNG. A 1280px
 * slot on a 2x display asks for 2560 device px — if the original tops the
 * ladder, every retina visitor downloads it instead of a WebP ~60x smaller.
 * The ladder's top rung is the intrinsic-width WebP the variant worker
 * encodes, so no quality ceiling is lost. The original survives only in
 * `src`, which width-descriptor srcsets reserve for non-srcset browsers.
 */
export function buildMediaSrcset(media: RenderResolvedMedia): string | null {
  if (!media.variants.length) return null
  return media.variants
    .slice()
    .sort((a, b) => a.width - b.width)
    .map((v) => `${safeUrl(v.path)} ${v.width}w`)
    .join(', ')
}

/**
 * Pick the smallest variant ≥ the asset's intrinsic width (or the caller's
 * target hint). Returns `null` when no usable URL is available.
 *
 * `safeUrl` is applied so the result is HTML-attribute-safe.
 */
export function pickMediaVariantUrl(
  media: RenderResolvedMedia | null,
  targetWidth: number | null,
): string | null {
  if (!media) return null
  if (!media.variants.length) {
    return media.publicPath ? safeUrl(media.publicPath) : null
  }
  const target = targetWidth ?? media.width ?? 1280
  const ladder = media.variants.slice().sort((a, b) => a.width - b.width)
  const pick = ladder.find((v) => v.width >= target) ?? ladder[ladder.length - 1]
  return safeUrl(pick.path)
}
