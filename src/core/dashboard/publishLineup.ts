import { DataTableKindSchema } from '@core/data/schemas'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const PublishLineupRowSchema = Type.Object({
  id: Type.String(),
  tableSlug: Type.String(),
  tableKind: DataTableKindSchema,
  slug: Type.String(),
  path: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal('scheduled'), Type.Literal('published'), Type.Literal('draft')]),
  at: Type.Union([Type.String(), Type.Null()]),
})

export const PublishLineupStatsSchema = Type.Object({
  rows: Type.Array(PublishLineupRowSchema),
})

export type PublishLineupRow = Static<typeof PublishLineupRowSchema>
export type PublishLineupStats = Static<typeof PublishLineupStatsSchema>
