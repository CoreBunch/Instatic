import { Type, type Static } from '../utils/typeboxHelpers'

export const ServiceActivitySchema = Type.Object({
  events: Type.Array(Type.Object({
    id: Type.String(), title: Type.String(), agent: Type.String(), at: Type.String(),
    scope: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.Integer(), Type.Null()]),
  })),
})
export type ServiceActivity = Static<typeof ServiceActivitySchema>['events'][number]
