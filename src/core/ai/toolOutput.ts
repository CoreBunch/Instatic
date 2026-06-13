import { Type, type Static } from '@core/utils/typeboxHelpers'

/**
 * One image attached to a tool result (base64-encoded). Lets a tool return
 * binary visual evidence (e.g. a `render_snapshot` PNG) through a dedicated
 * channel instead of stuffing the base64 into `data` as JSON text — drivers
 * forward it as a NATIVE image block (Anthropic) or drop it to a one-line
 * text note (providers whose tool-result channel is text-only).
 */
const AiToolImageSchema = Type.Object({
  mimeType: Type.String(),
  data: Type.String(),
})

export type AiToolImage = Static<typeof AiToolImageSchema>

export const AiToolOutputSchema = Type.Object({
  ok: Type.Boolean(),
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  /** Optional image attachments — see `AiToolImageSchema`. */
  images: Type.Optional(Type.Array(AiToolImageSchema)),
})

export type AiToolOutput = Static<typeof AiToolOutputSchema>

export function aiToolOk(data?: unknown, images?: AiToolImage[]): AiToolOutput {
  const out: AiToolOutput = { ok: true }
  if (data !== undefined) out.data = data
  if (images && images.length > 0) out.images = images
  return out
}

export function aiToolError(error: string): AiToolOutput {
  return { ok: false, error }
}
