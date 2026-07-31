import { Type, type Static } from '@core/utils/typeboxHelpers'

/** Clipboard formats accepted before the browser normalises an attachment. */
export const AI_USER_IMAGE_SOURCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export type AiUserImageSourceMimeType = typeof AI_USER_IMAGE_SOURCE_MIME_TYPES[number]

/**
 * User-image policy shared by browser ingestion and the server boundary.
 * The browser always re-encodes each accepted clipboard image to a bounded
 * JPEG, so providers receive one portable shape regardless of source format.
 */
export const AI_USER_IMAGE_MAX_SOURCE_BYTES = 12 * 1024 * 1024
export const AI_USER_IMAGE_MAX_SOURCE_EDGE = 16_384
export const AI_USER_IMAGE_MAX_SOURCE_PIXELS = 40_000_000
export const AI_USER_IMAGE_MAX_BYTES = 1_500_000
export const AI_USER_IMAGE_MAX_BASE64_CHARS = Math.ceil(AI_USER_IMAGE_MAX_BYTES / 3) * 4
export const AI_USER_IMAGE_MAX_EDGE = 1568
export const AI_USER_IMAGE_MAX_PIXELS = 1_500_000
/** Per-turn cap; conversation history itself has no image-count ceiling. */
export const AI_USER_IMAGE_MAX_PER_MESSAGE = 8

export const AiUserImageBlockSchema = Type.Object(
  {
    kind: Type.Literal('image'),
    mimeType: Type.Literal('image/jpeg'),
    data: Type.String({
      minLength: 4,
      maxLength: AI_USER_IMAGE_MAX_BASE64_CHARS,
    }),
  },
  { additionalProperties: false },
)

export type AiUserImageBlock = Static<typeof AiUserImageBlockSchema>

export function isAiUserImageSourceMimeType(
  value: string,
): value is AiUserImageSourceMimeType {
  return AI_USER_IMAGE_SOURCE_MIME_TYPES.some((mimeType) => mimeType === value)
}
