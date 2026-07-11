import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * Content blocks are the persisted, provider-agnostic vocabulary of a message's
 * body. They are stored verbatim in `ai_messages.content_json` and replayed by
 * `buildMessageHistory` into the `AiMessage[]` a driver sends each turn.
 *
 * `AiContentBlockSchema` is the single persisted/provider source of truth.
 * The browser-facing `AiContentViewBlockSchema` below reuses its non-image
 * members but projects durable image bytes to authenticated lazy URLs.
 */

export const AiTextBlockSchema = Type.Object({
  kind: Type.Literal('text'),
  text: Type.String(),
})

const AiImageBlockSchema = Type.Object({
  kind: Type.Literal('image'),
  mimeType: Type.String(),
  data: Type.String(/* base64 */),
})

export const AiToolCallBlockSchema = Type.Object({
  kind: Type.Literal('toolCall'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  input: Type.Unknown(),
})

/**
 * The outcome of a tool call, recorded on its `role:'tool'` message.
 *
 * This is a FIRST-CLASS block: `ok` is an explicit boolean, never inferred from
 * the emptiness of a text block. `error` carries the failure message when
 * `ok === false`.
 *
 * The heavy successful `data` an `AiToolOutput` may carry is intentionally NOT
 * persisted here — the model already consumed it in the round that produced the
 * result, and re-feeding large tool payloads on every replay would bloat the
 * context for no benefit. Replay only needs `{ ok, error }` to reconstruct the
 * `AiToolOutput` envelope the driver hands back to the model.
 */
export const AiToolResultBlockSchema = Type.Object({
  kind: Type.Literal('toolResult'),
  ok: Type.Boolean(),
  error: Type.Optional(Type.String()),
})

export const AiContentBlockSchema = Type.Union([
  AiTextBlockSchema,
  AiImageBlockSchema,
  AiToolCallBlockSchema,
  AiToolResultBlockSchema,
])

export type AiContentBlock = Static<typeof AiContentBlockSchema>

/**
 * Conversation-detail wire image. Persisted/provider blocks retain base64;
 * browser history receives an authenticated lazy URL so opening a long image
 * conversation does not inline the whole collection into one JSON response.
 */
export const AiContentViewImageBlockSchema = Type.Object(
  {
    kind: Type.Literal('image'),
    mimeType: Type.Literal('image/jpeg'),
    url: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

export const AiContentViewBlockSchema = Type.Union([
  AiTextBlockSchema,
  AiContentViewImageBlockSchema,
  AiToolCallBlockSchema,
  AiToolResultBlockSchema,
])

export type AiContentViewBlock = Static<typeof AiContentViewBlockSchema>
