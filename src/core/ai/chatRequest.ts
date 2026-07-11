import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  AI_USER_IMAGE_MAX_BASE64_CHARS,
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  AiUserImageBlockSchema,
} from './userImage'

/**
 * Eight maximum-sized JPEGs occupy about 16 MB once base64 encoded. Reserve a
 * further 16 MiB for JSON framing and the bounded editor snapshot while keeping
 * the HTTP boundary finite before JSON parsing.
 */
export const AI_CHAT_MAX_REQUEST_BYTES = (
  AI_USER_IMAGE_MAX_PER_MESSAGE * AI_USER_IMAGE_MAX_BASE64_CHARS
) + (16 * 1024 * 1024)

const AiUserTextBlockSchema = Type.Object(
  {
    kind: Type.Literal('text'),
    text: Type.String(),
  },
  { additionalProperties: false },
)

/** User-authored chat content cannot inject assistant/tool blocks. */
export const AiUserContentBlockSchema = Type.Union([
  AiUserTextBlockSchema,
  AiUserImageBlockSchema,
])

export type AiUserContentBlock = Static<typeof AiUserContentBlockSchema>

const AiUserContentSchema = Type.Union([
  // Image-only prompt.
  Type.Array(AiUserImageBlockSchema, {
    minItems: 1,
    maxItems: AI_USER_IMAGE_MAX_PER_MESSAGE,
  }),
  // Mixed or text-only prompt. `contains` + `maxContains` makes the single-text
  // invariant part of the HTTP schema while still allowing images in any order.
  Type.Array(AiUserContentBlockSchema, {
    minItems: 1,
    maxItems: AI_USER_IMAGE_MAX_PER_MESSAGE + 1,
    contains: AiUserTextBlockSchema,
    maxContains: 1,
  }),
])

export const AiChatRequestBodySchema = Type.Object(
  {
    conversationId: Type.String({ minLength: 1 }),
    content: AiUserContentSchema,
    // Scope-specific shape. The scope prompt builder validates it separately.
    snapshot: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
)

export type AiChatRequestBody = Static<typeof AiChatRequestBodySchema>
