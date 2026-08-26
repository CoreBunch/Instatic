/**
 * ImageViewer — the viewer body for image assets.
 *
 * Renders the asset using a viewer-appropriate variant + BlurHash placeholder
 * so the viewer doesn't block on the full original. Pure preview surface —
 * editing (alt text, caption, tags, replace file, …) lives in the sidebar of
 * the enclosing MediaViewerWindow.
 */
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { blurHashToDataUrl, buildVariantSrcset, pickVariantUrl } from '../../utils/variants'
import styles from './ImageViewer.module.css'

interface ImageViewerProps {
  asset: CmsMediaAsset
}

// Viewer preview area: ~600 CSS px wide inside the 880-px window minus the
// 300-px sidebar minus padding. The browser grabs the smallest variant ≥
// 600 (scaled by DPR), which is `w1024` on a 1× display and `w1600` on 2×.
const VIEWER_CSS_WIDTH = 600

export function ImageViewer({ asset }: ImageViewerProps) {
  const src = pickVariantUrl(asset, VIEWER_CSS_WIDTH)
  const srcset = buildVariantSrcset(asset)
  const blurHashUrl = blurHashToDataUrl(asset.blurHash)
  // The placeholder rides on the <img> itself, not the surrounding surface:
  // the image is letterboxed inside the viewer, and a background on the
  // container paints the BlurHash into the empty bands around it, which reads
  // as a broken grey strip above/below the photo. `--asset-ratio` sizes the
  // element to the asset's own aspect ratio so the element box *is* the
  // photo's box and the letterbox stays plain surface.
  const imageStyle = {
    ...(asset.width && asset.height ? { '--asset-ratio': `${asset.width} / ${asset.height}` } : null),
    ...(blurHashUrl ? { '--asset-blurhash': `url(${blurHashUrl})` } : null),
  } as React.CSSProperties
  return (
    <div className={styles.root}>
      <img
        src={src}
        srcSet={srcset}
        sizes="(min-width: 1024px) 640px, 100vw"
        alt={asset.altText || asset.filename}
        className={styles.image}
        style={imageStyle}
        draggable={false}
        loading="lazy"
        decoding="async"
      />
    </div>
  )
}
