import { Type, type Static } from '@core/utils/typeboxHelpers'
import { SiteVisitorPreferencesSchema } from '@core/visitor-preferences-schema'

export const VideoPropsSchema = Type.Object({
  playbackRole: Type.Union([Type.Literal('content'), Type.Literal('decorative')], { default: 'content' }),
  videoUrl: Type.String({ default: '' }),
  poster: Type.String({ default: '' }),
  autoplay: Type.Boolean({ default: false }),
  loop: Type.Boolean({ default: false }),
  muted: Type.Boolean({ default: false }),
  controls: Type.Boolean({ default: true }),
  playsinline: Type.Boolean({ default: true }),
  preload: Type.Union(
    [Type.Literal('none'), Type.Literal('metadata'), Type.Literal('auto')],
    { default: 'metadata' },
  ),
  /** Iframe title attribute for YouTube embeds. Improves accessibility. */
  title: Type.String({ default: 'YouTube video' }),
  /** When true, appends rel=0 to the YouTube embed URL to suppress related videos. */
  noRelatedVideos: Type.Boolean({ default: false }),
})

/** Browser-origin local assets, including public Files and ordinary root URLs. */
export const DecorativeVideoUrlSchema = Type.String({ pattern: '^/(?!/)[^\\\\\\s]+$' })
export const VideoPublishSchema = Type.Union([
  Type.Object({ props: Type.Object({ playbackRole: Type.Literal('content') }) }),
  Type.Object({
      props: Type.Object({
        playbackRole: Type.Literal('decorative'), muted: Type.Literal(true),
        controls: Type.Literal(false), playsinline: Type.Literal(true),
        videoUrl: DecorativeVideoUrlSchema,
      }),
      settings: Type.Object({ visitorPreferences: SiteVisitorPreferencesSchema }),
  }),
], { description: 'Decorative video requires visitor defaults, a self-hosted root URL, muted audio, inline playback and no controls.' })

export type VideoStoredProps = Static<typeof VideoPropsSchema>
