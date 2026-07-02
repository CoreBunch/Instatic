/**
 * base.video editor preview component.
 *
 * Mirrors what the publisher emits so the canvas WYSIWYG reflects the
 * shipped HTML:
 *   - resolved poster (with smallest-fits variant pick) so the still
 *     frame appears immediately instead of after `preload="metadata"`
 *     finishes.
 *   - intrinsic `width` / `height` from the resolved video asset to
 *     prevent CLS on the canvas.
 *   - the same `playsinline` / `autoplay` / `loop` / `muted` /
 *     `controls` props.
 *
 * For YouTube URLs the canvas paints the responsive poster on top of a
 * `loading="lazy"` iframe — same JS-free facade the published HTML
 * uses, so authors get an honest preview of what visitors will see.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. The `youtube.ts` sibling owns the URL
 * helpers shared with `index.ts`.
 */
import React from 'react'
import type { CSSProperties } from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { useCmsMediaAssetByPath } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { buildVariantSrcset, pickVariantUrl } from '@admin/pages/media/utils/variants'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { parseYoutubeId, youtubeEmbedUrl } from './youtube'
import type { VideoStoredProps } from './props'

// Canvas tile width hint — drives the poster variant pick. Videos in the
// editor preview usually render at half the published-page width because
// the canvas is scaled down; 480 px is a sensible default DPR-aware
// target.
const CANVAS_CSS_WIDTH = 480

// Inline styles for the YouTube facade — match the published CSS in
// `index.ts`. The video module has no `.module.css` (the canvas surface
// lives entirely in this component), so the few rules needed are
// co-located as typed style objects.
const FACADE_WRAP_STYLE: CSSProperties = {
  position: 'relative',
  display: 'block',
  width: '100%',
  aspectRatio: '16 / 9',
  backgroundColor: '#000',
  overflow: 'hidden',
}
const FACADE_LAYER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'block',
  border: 0,
}
const FACADE_POSTER_STYLE: CSSProperties = { ...FACADE_LAYER_STYLE, objectFit: 'cover' }
const FACADE_FRAME_STYLE: CSSProperties = { ...FACADE_LAYER_STYLE, background: 'transparent', zIndex: 1 }
// Transparent click-shield rendered on top of the iframe in the canvas
// ONLY. The iframe has its own browsing context — even when we set
// `pointer-events: none` on it, the YouTube player can still intercept
// hover / wheel / focus in ways that block module selection. The shield
// is a normal DOM element above the iframe, so canvas clicks bubble up
// to the NodeRenderer wrapper cleanly. This element is editor-only —
// the publisher's `render()` in index.ts does not emit it.
const FACADE_SHIELD_STYLE: CSSProperties = {
  ...FACADE_LAYER_STYLE,
  zIndex: 2,
  background: 'transparent',
  cursor: 'pointer',
}

export const VideoEditor: React.FC<ModuleComponentProps<VideoStoredProps>> = ({ props, mcClassName, nodeWrapperProps }) => {
  const youtubeId = parseYoutubeId(props.videoUrl || '')

  // Resolve both assets in parallel via the per-path cache. For YouTube
  // URLs the videoUrl isn't a library asset, so that lookup returns null —
  // harmless.
  const videoAsset = useCmsMediaAssetByPath(!youtubeId ? props.videoUrl || null : null)
  const posterAsset = useCmsMediaAssetByPath(props.poster || null)

  const posterUrl = posterAsset ? pickVariantUrl(posterAsset, CANVAS_CSS_WIDTH) : props.poster || null

  const posterSrcset = posterAsset ? buildVariantSrcset(posterAsset) ?? null : null

  const intrinsic = videoAsset
    ? { width: videoAsset.width ?? undefined, height: videoAsset.height ?? undefined }
    : null

  // ─── YouTube ────────────────────────────────────────────────────────────
  if (youtubeId) {
    const src = youtubeEmbedUrl(youtubeId, props.autoplay, props.noRelatedVideos)
    const iframeTitle = props.title || 'YouTube video'
    if (posterUrl) {
      return (
        <div {...nodeWrapperProps} className={mcClassName} style={FACADE_WRAP_STYLE}>
          <img
            src={posterUrl}
            srcSet={posterSrcset ?? undefined}
            sizes={posterSrcset ? '100vw' : undefined}
            alt=""
            loading="eager"
            decoding="async"
            style={FACADE_POSTER_STYLE}
          />
          <iframe
            src={src}
            title={iframeTitle}
            loading="lazy"
            frameBorder="0"
            allow="autoplay; encrypted-media; fullscreen"
            allowFullScreen
            style={FACADE_FRAME_STYLE}
          />
          {/* Editor-only click-shield — see FACADE_SHIELD_STYLE comment. */}
          <span aria-hidden="true" style={FACADE_SHIELD_STYLE} />
        </div>
      )
    }
    return (
      <div {...nodeWrapperProps} className={mcClassName} style={FACADE_WRAP_STYLE}>
        <iframe
          src={src}
          title={iframeTitle}
          loading="lazy"
          frameBorder="0"
          allow="autoplay; encrypted-media; fullscreen"
          allowFullScreen
          style={FACADE_FRAME_STYLE}
        />
        {/* Editor-only click-shield — even with `.nodeWrapper iframe`
            pointer-events:none, YouTube's player can still swallow
            canvas interaction. The shield guarantees clicks reach the
            NodeRenderer wrapper so the module stays selectable. */}
        <span aria-hidden="true" style={FACADE_SHIELD_STYLE} />
      </div>
    )
  }

  // ─── No URL yet ─────────────────────────────────────────────────────────
  if (!props.videoUrl) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<VideoSolidIcon size={16} />}
        label="No video selected"
      />
    )
  }

  // ─── Uploaded / external video ──────────────────────────────────────────
  return (
    <video
      {...nodeWrapperProps}
      className={mcClassName}
      src={props.videoUrl}
      poster={posterUrl ?? undefined}
      width={intrinsic?.width}
      height={intrinsic?.height}
      preload={props.preload}
      playsInline={props.playsinline}
      autoPlay={props.autoplay}
      loop={props.loop}
      muted={props.muted}
      controls={props.controls}
    />
  )
}
