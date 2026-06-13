/**
 * base.video — video embed module.
 *
 * One field decides how the video is sourced: `videoUrl`. The publisher
 * looks at the URL and emits the right markup:
 *   - YouTube URL (watch / youtu.be / embed / shorts) → `<iframe>`.
 *   - Anything else (a media-library `/uploads/...` path or an external
 *     `.mp4` / `.webm` URL) → `<video>`.
 *
 * The author never has to pick "Media library vs. YouTube" — the URL is
 * the source of truth.
 *
 * Performance: when a `poster` image is set, the YouTube iframe is wrapped
 * in a `<div>` so the responsive poster (`srcset` from the variant ladder)
 * renders immediately while the iframe itself is `loading="lazy"`. Visitors
 * see our lightweight poster on first paint; YouTube's player only streams
 * in when the element is in the viewport. JS-free — purely native browser
 * lazy-loading + a z-stack so the iframe covers the poster once loaded.
 *
 * The publisher's `prefetchMediaAssets` pass attaches every resolved media
 * asset to `props._resolvedMediaByKey`. We read TWO entries: `videoUrl`
 * (for intrinsic width / height of the video itself, when it's a library
 * upload) and `poster` (variant ladder + intrinsic dims). Both are
 * optional — missing values fall back gracefully.
 */
import { registry } from '@core/module-engine'
import type { ModuleDefinition } from '@core/module-engine'
import type { RenderResolvedMedia } from '@core/publisher'
import { Type, Value } from '@core/utils/typeboxHelpers'
import type { Static } from '@core/utils/typeboxHelpers'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { safeUrl } from '@modules/base/utils/escape'
import { buildMediaSrcset, pickMediaVariantUrl } from '@modules/base/utils/mediaAttrs'
import { VideoEditor } from './VideoEditor'
import { parseYoutubeId, youtubeEmbedUrl } from './youtube'

// ---------------------------------------------------------------------------
// Props schema — authored fields only. The publisher-injected field
// (_resolvedMediaByKey) is NOT declared here; validateNodeProps merges it
// over the cleaned props so it survives the coercion step untouched.
// ---------------------------------------------------------------------------

const VideoPropsSchema = Type.Object({
  /**
   * Source URL. Accepts:
   *   - A library path like `/uploads/intro.mp4` (resolved by the publisher)
   *   - An external video URL (`https://example.com/clip.webm`)
   *   - Any standard YouTube URL — auto-detected, rendered as an iframe
   */
  videoUrl: Type.String({ default: '' }),
  /**
   * Poster frame. For uploaded videos, the browser's native poster.
   * For YouTube URLs, also rendered behind the iframe so the page shows
   * our responsive image immediately while YouTube lazy-loads.
   */
  poster: Type.String({ default: '' }),
  autoplay: Type.Boolean({ default: false }),
  loop: Type.Boolean({ default: false }),
  muted: Type.Boolean({ default: false }),
  controls: Type.Boolean({ default: true }),
  /** Required for iOS so an uploaded video doesn't take over the screen. */
  playsinline: Type.Boolean({ default: true }),
  /** Bandwidth hint for uploaded videos. Ignored for YouTube embeds. */
  preload: Type.Union(
    [Type.Literal('none'), Type.Literal('metadata'), Type.Literal('auto')],
    { default: 'metadata' },
  ),
})

/** Authored (stored) props — shape the user edits and the database persists. */
export type VideoStoredProps = Static<typeof VideoPropsSchema>

/**
 * Full render-time props. Intersects the authored schema shape with the
 * publisher-injected field that arrives after validateNodeProps runs.
 * `_resolvedMediaByKey` is NOT in VideoPropsSchema — it bypasses schema
 * cleaning via the `{ ...rawProps, ...cleaned }` merge in validateNodeProps.
 * The `& Record<string, unknown>` satisfies the
 * ModuleDefinition<TProps extends Record<string, unknown>> constraint.
 */
type VideoProps = VideoStoredProps & {
  /** Internal: attached by the publisher's prefetchMediaAssets pass. */
  _resolvedMediaByKey?: Record<string, RenderResolvedMedia>
} & Record<string, unknown>

export const VideoModule: ModuleDefinition<VideoProps> = {
  id: 'base.video',
  name: 'Video',
  description: 'Embed an uploaded video, an external video URL, or a YouTube link.',
  category: 'Media',
  version: '4.0.0',
  icon: VideoSolidIcon,
  trusted: true,
  canHaveChildren: false,

  propsSchema: VideoPropsSchema,

  schema: {
    videoUrl: {
      type: 'media',
      mediaKind: 'video',
      label: 'Video',
      description: 'Pick a file from the media library, paste an external URL, or paste a YouTube link.',
    },
    poster: {
      type: 'image',
      label: 'Poster image',
      description: 'Shown before the video starts. For YouTube, also shown while the player lazy-loads.',
    },
    autoplay: { type: 'toggle', label: 'Autoplay' },
    loop: { type: 'toggle', label: 'Loop' },
    muted: { type: 'toggle', label: 'Muted' },
    controls: { type: 'toggle', label: 'Show controls' },
    playsinline: { type: 'toggle', label: 'Play inline (mobile)' },
    preload: {
      type: 'select',
      label: 'Preload',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Metadata', value: 'metadata' },
        { label: 'Auto', value: 'auto' },
      ],
    },
  },

  // Single source of truth: defaults are derived from the schema's `default`
  // annotations so they can never diverge from the declared shape.
  defaults: Value.Create(VideoPropsSchema),

  component: VideoEditor,

  htmlTag: (props) => {
    const url = String(props.videoUrl ?? '')
    if (parseYoutubeId(url)) {
      // With a poster we wrap the iframe in a <div> so the responsive
      // poster image can sit behind it (see render below). Without a
      // poster the iframe is the root.
      return String(props.poster ?? '') ? 'div' : 'iframe'
    }
    return 'video'
  },

  render: (props) => {
    const rawUrl = String(props.videoUrl ?? '')
    const youtubeId = parseYoutubeId(rawUrl)

    if (youtubeId) {
      return renderYoutube({
        youtubeId,
        autoplay: Boolean(props.autoplay),
        posterUrl: String(props.poster ?? ''),
        posterMedia: props._resolvedMediaByKey?.poster ?? null,
      })
    }

    const videoSrc = safeUrl(rawUrl)
    if (!videoSrc) return { html: '<video></video>' }

    // Resolved video asset gives us intrinsic dimensions — emits
    // `width` / `height` attrs so the browser reserves layout space
    // before the metadata downloads. Same CLS-avoidance trick as the
    // image module.
    const videoMedia = props._resolvedMediaByKey?.videoUrl ?? null
    const posterMedia = props._resolvedMediaByKey?.poster ?? null

    // Poster picks the smallest variant that's still ≥ the video's
    // own width — keeps the still file lightweight while staying sharp
    // at the rendered size. Falls back to the raw publicPath if no
    // variant ladder is available yet.
    const posterSrc = pickMediaVariantUrl(posterMedia, videoMedia?.width ?? null)
      ?? safeUrl(String(props.poster ?? ''))

    const width = videoMedia?.width ?? null
    const height = videoMedia?.height ?? null
    const preload =
      props.preload === 'none' ? 'none' : props.preload === 'auto' ? 'auto' : 'metadata'

    const attrs: string[] = [`src="${videoSrc}"`]
    if (posterSrc) attrs.push(`poster="${posterSrc}"`)
    if (width !== null) attrs.push(`width="${width}"`)
    if (height !== null) attrs.push(`height="${height}"`)
    attrs.push(`preload="${preload}"`)
    if (props.playsinline) attrs.push('playsinline')
    if (props.autoplay) attrs.push('autoplay')
    if (props.loop) attrs.push('loop')
    if (props.muted) attrs.push('muted')
    if (props.controls) attrs.push('controls')

    return { html: `<video ${attrs.join(' ')}></video>` }
  },
}

// ---------------------------------------------------------------------------
// YouTube — facade render
// ---------------------------------------------------------------------------

interface YoutubeRenderInput {
  youtubeId: string
  autoplay: boolean
  /** Raw author-set poster URL (already escapeProps-passed). */
  posterUrl: string
  /** Resolved poster asset (variants, intrinsic dims) if the publisher pre-pass ran. */
  posterMedia: RenderResolvedMedia | null
}

/**
 * Emit a YouTube iframe.
 *
 * With a poster: wrap the iframe in a `<div>` that also contains a
 * responsive `<img>` of the poster. The poster paints immediately; the
 * iframe is `loading="lazy"` so YouTube's player network requests only
 * fire when the element is in the viewport. Once the iframe loads, it
 * sits on top of the poster (CSS z-stack) and the visitor sees the real
 * player. Zero JS in the published HTML — pure native browser behaviour.
 *
 * Without a poster: emit just the iframe, also `loading="lazy"`.
 */
function renderYoutube(input: YoutubeRenderInput): { html: string; css?: string } {
  const embedSrc = youtubeEmbedUrl(input.youtubeId, input.autoplay)
  if (!embedSrc) return { html: '' }

  const iframeAttrs = [
    `src="${embedSrc}"`,
    `title="YouTube video"`,
    `loading="lazy"`,
    `frameborder="0"`,
    `allow="autoplay; encrypted-media; fullscreen"`,
    `allowfullscreen`,
  ]
  const iframeHtml = `<iframe ${iframeAttrs.join(' ')}></iframe>`

  if (!input.posterUrl && !input.posterMedia) {
    return { html: iframeHtml }
  }

  // Poster aspect target — derives the variant pick. YouTube embeds are
  // 16:9 by default, so 1280 is the sensible "rendered hero width" hint.
  const posterTargetWidth = input.posterMedia?.width ?? 1280
  const posterSrc =
    pickMediaVariantUrl(input.posterMedia, posterTargetWidth)
    ?? safeUrl(input.posterUrl)

  if (!posterSrc) {
    // Poster prop set but URL didn't survive safeUrl — fall back to
    // bare iframe rather than emitting an `<img src>` we can't trust.
    return { html: iframeHtml }
  }

  const posterSrcset = input.posterMedia ? buildMediaSrcset(input.posterMedia) : null
  const posterWidth = input.posterMedia?.width ?? null
  const posterHeight = input.posterMedia?.height ?? null

  const imgAttrs: string[] = [
    `class="bv-yt-poster"`,
    `src="${posterSrc}"`,
    `alt=""`,
    `loading="eager"`,
    `fetchpriority="high"`,
    `decoding="async"`,
  ]
  if (posterSrcset) {
    imgAttrs.push(`srcset="${posterSrcset}"`, `sizes="100vw"`)
  }
  if (posterWidth !== null) imgAttrs.push(`width="${posterWidth}"`)
  if (posterHeight !== null) imgAttrs.push(`height="${posterHeight}"`)

  const html =
    `<div class="bv-yt">`
    + `<img ${imgAttrs.join(' ')}>`
    + `<iframe class="bv-yt-frame" ${iframeAttrs.join(' ')}></iframe>`
    + `</div>`

  return { html, css: YOUTUBE_FACADE_CSS }
}

// Scoped to `.bv-yt` so the publisher's per-moduleId CSS dedup applies
// (one block per page, not per instance). Constraint #310: this string
// is props-independent — no template interpolation of `props.*`.
const YOUTUBE_FACADE_CSS = `
.bv-yt {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  background-color: #000;
  overflow: hidden;
}
.bv-yt > .bv-yt-poster,
.bv-yt > .bv-yt-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  border: 0;
}
.bv-yt > .bv-yt-poster {
  object-fit: cover;
}
.bv-yt > .bv-yt-frame {
  background: transparent;
  z-index: 1;
}
`.trim()

registry.registerOrReplace(VideoModule)
