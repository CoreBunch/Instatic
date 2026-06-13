import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * Content blocks are the persisted, provider-agnostic vocabulary of a message's
 * body. They are stored verbatim in `ai_messages.content_json` and replayed by
 * `buildMessageHistory` into the `AiMessage[]` a driver sends each turn.
 *
 * This schema is the SINGLE source of truth for the block shape — the server
 * runtime types (`AiContentBlock`), the persistence boundary
 * (`ContentBlocksSchema` in `conversations/store.ts`), and the client wire
 * schema (`MessageViewSchema` in `src/admin/ai/api.ts`) all derive from it.
 * Add a kind here and every reader/writer sees it.
 */

const AiTextBlockSchema = Type.Object({
  kind: Type.Literal('text'),
  text: Type.String(),
})

const AiImageBlockSchema = Type.Object({
  kind: Type.Literal('image'),
  mimeType: Type.String(),
  data: Type.String(/* base64 */),
})

const AiToolCallBlockSchema = Type.Object({
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
const AiToolResultBlockSchema = Type.Object({
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
