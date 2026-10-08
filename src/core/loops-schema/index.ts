/** Pure data shape shared by loop sources and render contexts. */
import { Type, type Static } from '@sinclair/typebox'

export const LoopItemSchema = Type.Object({
  /** Stable identity — used for keying in the editor and infinite-load dedup. */
  id: Type.String(),
  /** Field values keyed by `LoopSourceField.id`. */
  fields: Type.Record(Type.String(), Type.Unknown()),
})

export type LoopItem = Static<typeof LoopItemSchema>

export const LoopPageResponseSchema = Type.Object({
  html: Type.String(),
  hasMore: Type.Boolean(),
  pageNumber: Type.Integer({ minimum: 1 }),
})
export type LoopPageResponse = Static<typeof LoopPageResponseSchema>
