import { Type, type Static } from '@core/utils/typeboxHelpers'

/** Author-controlled fields for the first-party Google Maps embed. */
export const GoogleMapPropsSchema = Type.Object({
  /** Official Google Maps Embed URL, not a share URL or arbitrary iframe source. */
  embedUrl: Type.String({ default: '' }),
  /** Required accessible name for the embedded map. */
  title: Type.String({ default: 'Google Maps location' }),
})

export type GoogleMapStoredProps = Static<typeof GoogleMapPropsSchema>
