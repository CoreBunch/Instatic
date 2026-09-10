import { Type, type Static } from '@core/utils/typeboxHelpers'

/** Totals count logical pages; the remaining counters count authored language variants. */
export const DashboardPagesStatsSchema = Type.Object({
  total: Type.Number(), variants: Type.Number(), published: Type.Number(), drafts: Type.Number(),
  offline: Type.Number(), scheduled: Type.Number(), deltaPublishedThisWeek: Type.Number(),
})
export type DashboardPagesStats = Static<typeof DashboardPagesStatsSchema>

export const DashboardPostsStatsSchema = Type.Object({
  total: Type.Number(), variants: Type.Number(), categories: Type.Number(), scheduled: Type.Number(),
  daily28: Type.Array(Type.Number()),
})
export type DashboardPostsStats = Static<typeof DashboardPostsStatsSchema>

export const DashboardPublishLineupRowSchema = Type.Object({
  id: Type.String(), localeId: Type.String(), localeCode: Type.String(), localeEnabled: Type.Boolean(),
  title: Type.String(), path: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal('scheduled'), Type.Literal('published'), Type.Literal('draft'), Type.Literal('offline')]),
  at: Type.Union([Type.String(), Type.Null()]),
})
export type DashboardPublishLineupRow = Static<typeof DashboardPublishLineupRowSchema>
export const DashboardPublishLineupStatsSchema = Type.Object({ rows: Type.Array(DashboardPublishLineupRowSchema) })
export type DashboardPublishLineupStats = Static<typeof DashboardPublishLineupStatsSchema>
