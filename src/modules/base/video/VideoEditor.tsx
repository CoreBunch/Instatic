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
import type { ModuleComponentProps } from '@core/module-engine'
import { useCmsMediaAssetByPath } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { buildVariantSrcset, pickVariantUrl } from '@admin/pages/media/utils/variants'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { parseYoutubeId, youtubeEmbedUrl } from './youtube'
import type { VideoStoredProps } from './props'
import { VideoPublishSchema } from './props'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { useEditorStore } from '@site/store/store'
import { cn } from '@ui/cn'
import s from './Video.module.css'

// Canvas tile width hint — drives the poster variant pick. Videos in the
// editor preview usually render at half the published-page width because
// the canvas is scaled down; 480 px is a sensible default DPR-aware
// target.
const CANVAS_CSS_WIDTH = 480

export const VideoEditor: React.FC<ModuleComponentProps<VideoStoredProps>> = ({ props, mcClassName, nodeWrapperProps }) => {
  const settings = useEditorStore(state => state.site?.settings)
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

  const decorative = props.playbackRole === 'decorative'
  if (decorative && !compiledCheck(VideoPublishSchema, { props, settings })) {
    return <CanvasModulePlaceholder {...nodeWrapperProps} className={mcClassName} icon={<VideoSolidIcon size={16} />} label="Decorative video requires visitor defaults, a self-hosted source, muted audio, inline playback and no controls." />
  }

  // ─── YouTube ────────────────────────────────────────────────────────────
  if (youtubeId) {
    const src = youtubeEmbedUrl(youtubeId, props.autoplay, props.noRelatedVideos)
    const iframeTitle = props.title || 'YouTube video'
    if (posterUrl) {
      return (
        <div {...nodeWrapperProps} className={cn(mcClassName, s.facade)}>
          <img
            src={posterUrl}
            srcSet={posterSrcset ?? undefined}
            sizes={posterSrcset ? '100vw' : undefined}
            alt=""
            loading="eager"
            decoding="async"
            className={s.poster}
          />
          <iframe
            src={src}
            title={iframeTitle}
            loading="lazy"
            frameBorder="0"
            allow="autoplay; encrypted-media; fullscreen"
            allowFullScreen
            className={s.frame}
          />
          {/* Editor-only click-shield — keeps iframe interactions from selecting the player. */}
          <span aria-hidden="true" className={s.shield} />
        </div>
      )
    }
    return (
      <div {...nodeWrapperProps} className={cn(mcClassName, s.facade)}>
        <iframe
          src={src}
          title={iframeTitle}
          loading="lazy"
          frameBorder="0"
          allow="autoplay; encrypted-media; fullscreen"
          allowFullScreen
          className={s.frame}
        />
        {/* Editor-only click-shield — even with `.nodeWrapper iframe`
            pointer-events:none, YouTube's player can still swallow
            canvas interaction. The shield guarantees clicks reach the
            NodeRenderer wrapper so the module stays selectable. */}
        <span aria-hidden="true" className={s.shield} />
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
      src={decorative ? undefined : props.videoUrl}
      data-instatic-decorative-src={decorative ? props.videoUrl : undefined}
      data-instatic-decorative-preload={decorative ? props.preload : undefined}
      data-instatic-decorative-autoplay={decorative ? String(props.autoplay) : undefined}
      data-instatic-decorative-ready={decorative ? 'false' : undefined}
      aria-hidden={decorative ? true : undefined}
      poster={posterUrl ?? undefined}
      width={intrinsic?.width}
      height={intrinsic?.height}
      preload={decorative ? 'none' : props.preload}
      playsInline={props.playsinline}
      autoPlay={decorative ? undefined : props.autoplay}
      loop={props.loop}
      muted={props.muted}
      controls={props.controls}
    />
  )
}
