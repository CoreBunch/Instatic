import { Type, type Static } from '@core/utils/typeboxHelpers'
import { AiUserImageBlockSchema } from './userImage'

/** Generous envelope cap: one normalised image is ~2 MB base64; the rest is snapshot. */
export const AI_CHAT_MAX_REQUEST_BYTES = 16 * 1024 * 1024

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

export const AiChatRequestBodySchema = Type.Object(
  {
    conversationId: Type.String({ minLength: 1 }),
    content: Type.Array(AiUserContentBlockSchema, { minItems: 1, maxItems: 2 }),
    // Scope-specific shape. The scope prompt builder validates it separately.
    snapshot: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
)

export type AiChatRequestBody = Static<typeof AiChatRequestBodySchema>
