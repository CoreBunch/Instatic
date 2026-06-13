/**
 * Image — srcset-aware admin image primitive.
 *
 * Most admin surfaces render media thumbs by setting `<img src={asset.publicPath}>`
 * directly, which:
 *   • Always downloads the full-size original even for 80×80 thumbnails.
 *   • Ignores the variant ladder the host already generates at upload time
 *     (multiple widths + formats live in `asset.variants[]`).
 *
 * This primitive consumes either:
 *   • A full `CmsMediaAsset` — auto-builds `srcset` from `asset.variants`,
 *     uses `asset.publicPath` as the fallback `src`. Width attributes on
 *     the `<img>` come from `asset.width`/`asset.height` when available so
 *     the browser can avoid layout shift before the image decodes.
 *
 *   • Loose `src + variants?` — for callers that synthesize media-shaped
 *     props from other sources.
 *
 *   • Plain `src` only — degrades to a regular `<img>` with no srcset.
 *
 * The browser picks the right variant from the `srcset` ladder based on
 * the rendered size (which `sizes` describes). For thumbnail use cases
 * a `sizes="80px"` keeps the browser on the smallest variant; for full-
 * width hero shots a `sizes="100vw"` picks the closest match to viewport.
 */
import type { ImgHTMLAttributes } from 'react'
import type { CmsMediaAsset } from '@core/persistence'

/**
 * Loose variant shape the `<Image>` srcset builder accepts. Wider than
 * `CmsMediaVariant` so callers can pass:
 *
 *   • A full `CmsMediaVariant[]` from the media repo (strict format
 *     union, includes `sizeBytes` we don't need).
 *   • Dashboard-stats payload variants where `format` is a plain
 *     string from the JSON wire (not a TypeScript literal union).
 *   • Hand-built thumbnail ladders from tests or future endpoints.
 *
 * `format` is `string` here; the builder filters internally for the
 * formats the browser can decode from a `srcset` (webp / avif). Other
 * formats are dropped — the browser falls back to the plain `src`.
 */
interface ImageVariantInput {
  width: number
  height: number
  format: string
  path: string
}

interface CommonProps {
  /**
   * Alt text. Required — accessibility regression otherwise. Pass empty
   * string ('') if the image is purely decorative (the browser then
   * treats it as `role="presentation"`).
   */
  alt: string
  /**
   * `sizes` attribute the browser uses to pick from the `srcset`
   * ladder. Defaults to `100vw` which is safe but conservative —
   * always pass the actual rendered size when known (e.g. `80px` for a
   * thumbnail grid, `(min-width: 600px) 50vw, 100vw` for a responsive
   * card).
   */
  sizes?: string
  /** Forwarded to `<img>` so the caller can apply CSS-module classes. */
  className?: string
  /**
   * Forwarded to `<img>`. Most admin surfaces want `'lazy'` (the
   * default) so off-screen thumbs don't block the initial paint.
   */
  loading?: ImgHTMLAttributes<HTMLImageElement>['loading']
  /** Forwarded to `<img>` for explicit aspect-ratio reservation. */
  width?: number
  /** Forwarded to `<img>` for explicit aspect-ratio reservation. */
  height?: number
}

type ImageProps =
  | (CommonProps & {
      /**
       * Full media asset. The component reads `publicPath` for the
       * default `src` and builds `srcset` from `variants`.
       */
      asset: CmsMediaAsset
    })
  | (CommonProps & {
      /** Explicit src URL when the caller doesn't have a `CmsMediaAsset`. */
      src: string
      /**
       * Optional variant ladder for `srcset` construction. Omit when
       * the caller only has the bare URL — the component degrades to a
       * single-src `<img>`. Accepts a looser shape than the full
       * `CmsMediaVariant` (only width/height/format/path needed) so
       * partial-response payloads work without casting.
       */
      variants?: readonly ImageVariantInput[]
    })

/**
 * Pick the variants we want in the srcset ladder. We prefer WebP first
 * (smaller, near-universal support); the browser falls back to the
 * original `src` if it can't decode WebP. AVIF goes second — best
 * compression but ~6% of users still lack support per caniuse.com.
 * Filter out PNG/JPEG variants since they're rarely smaller than the
 * original PNG/JPEG.
 */
function buildSrcSet(variants: readonly ImageVariantInput[]): string | undefined {
  const preferred = variants.filter((v) => v.format === 'webp' || v.format === 'avif')
  if (preferred.length === 0) return undefined
  return preferred
    .map((v) => `${v.path} ${v.width}w`)
    .join(', ')
}

export function Image(props: ImageProps) {
  // Normalise the two input shapes into a single set of derived
  // values so the JSX is a tight one-pass <img>.
  const { src, variants, width, height } =
    'asset' in props
      ? {
          src: props.asset.publicPath,
          variants: props.asset.variants,
          width: props.width ?? props.asset.width ?? undefined,
          height: props.height ?? props.asset.height ?? undefined,
        }
      : {
          src: props.src,
          variants: props.variants ?? [],
          width: props.width,
          height: props.height,
        }

  const srcSet = variants.length > 0 ? buildSrcSet(variants) : undefined

  return (
    <img
      src={src}
      srcSet={srcSet}
      sizes={props.sizes ?? (srcSet ? '100vw' : undefined)}
      alt={props.alt}
      className={props.className}
      loading={props.loading ?? 'lazy'}
      width={width}
      height={height}
      decoding="async"
    />
  )
}
