import { Type, type Static } from '@sinclair/typebox'
import { LocaleSchema, LocalizationAvailabilitySchema } from './schemas'

export const PublishVariantSelectionSchema = Type.Object({
  variants: Type.Optional(Type.Array(Type.Object({
    rowId: Type.String({ minLength: 1 }),
    localeId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { maxItems: 10000 })),
}, { additionalProperties: false })
export type PublishVariantSelection = Static<typeof PublishVariantSelectionSchema>

export const PublicationOverviewSchema = Type.Object({
  locales: Type.Array(LocaleSchema),
  variants: Type.Array(Type.Object({
    rowId: Type.String(), localeId: Type.String(), title: Type.String(), slug: Type.String(),
    isTemplate: Type.Boolean(),
    availability: LocalizationAvailabilitySchema,
    scheduledPublishAt: Type.Union([Type.String(), Type.Null()]),
    publicPath: Type.Union([Type.String(), Type.Null()]),
  })),
})
export type PublicationOverview = Static<typeof PublicationOverviewSchema>
