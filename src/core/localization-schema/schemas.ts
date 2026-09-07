import { Type, type Static } from '@core/utils/typeboxHelpers'

export const LocaleDirectionSchema = Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])

export const FieldLocalizationSchema = Type.Union([Type.Literal('shared'), Type.Literal('localized')])
export type FieldLocalization = Static<typeof FieldLocalizationSchema>

export const LocaleInputSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 85 }),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** One URL segment without slashes; the default locale uses the empty prefix. */
  pathPrefix: Type.String({ maxLength: 100 }),
  enabled: Type.Boolean(),
  direction: LocaleDirectionSchema,
}, { additionalProperties: false })
export type LocaleInput = Static<typeof LocaleInputSchema>

export const LocaleSchema = Type.Composite([
  LocaleInputSchema,
  Type.Object({ id: Type.String(), isDefault: Type.Boolean() }),
])
export type Locale = Static<typeof LocaleSchema>

export const LocaleUpdateInputSchema = Type.Partial(LocaleInputSchema)
export type LocaleUpdateInput = Static<typeof LocaleUpdateInputSchema>

export const LocaleNodeOverrideSchema = Type.Object({
  props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  hidden: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })
export type LocaleNodeOverride = Static<typeof LocaleNodeOverrideSchema>

export const LocaleTreeOverridesSchema = Type.Record(Type.String(), LocaleNodeOverrideSchema)
export type LocaleTreeOverrides = Static<typeof LocaleTreeOverridesSchema>

export const LocaleTreeCellSchema = Type.Object({ nodes: LocaleTreeOverridesSchema }, { additionalProperties: false })
export type LocaleTreeCell = Static<typeof LocaleTreeCellSchema>

export const TranslationFieldMetadataSchema = Type.Object({
  sourceFingerprint: Type.String(),
  reviewState: Type.Union([Type.Literal('needs_review'), Type.Literal('reviewed')]),
}, { additionalProperties: false })
export type TranslationFieldMetadata = Static<typeof TranslationFieldMetadataSchema>

export const TranslationMetadataSchema = Type.Record(Type.String(), TranslationFieldMetadataSchema)
export type TranslationMetadata = Static<typeof TranslationMetadataSchema>

export const LocalizationAvailabilitySchema = Type.Union([Type.Literal('offline'), Type.Literal('online')])
export type LocalizationAvailability = Static<typeof LocalizationAvailabilitySchema>

const CellsSchema = Type.Record(Type.String(), Type.Unknown())
const NullableStringSchema = Type.Union([Type.String(), Type.Null()])

/** A scheduled publication freezes the selected revision, independently of later draft edits. */
export const ScheduledLocalizationRevisionSchema = Type.Object({
  cells: CellsSchema,
  slug: Type.String(),
  siteSnapshotId: Type.Optional(Type.String()),
  publicPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, { additionalProperties: false })
export type ScheduledLocalizationRevision = Static<typeof ScheduledLocalizationRevisionSchema>

export const ContentLocalizationSchema = Type.Object({
  rowId: Type.String(),
  localeId: Type.String(),
  cells: CellsSchema,
  slug: Type.String(),
  availability: LocalizationAvailabilitySchema,
  activeVersionId: NullableStringSchema,
  scheduledPublishAt: NullableStringSchema,
  scheduledRevision: Type.Union([ScheduledLocalizationRevisionSchema, Type.Null()]),
  translationMeta: TranslationMetadataSchema,
  seq: Type.Number(),
  createdByUserId: NullableStringSchema,
  updatedByUserId: NullableStringSchema,
  publishedByUserId: NullableStringSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  publishedAt: NullableStringSchema,
})
export type ContentLocalization = Static<typeof ContentLocalizationSchema>

export const ContentLocalizationDraftInputSchema = Type.Object({
  cells: CellsSchema,
  slug: Type.String(),
  translationMeta: Type.Optional(TranslationMetadataSchema),
}, { additionalProperties: false })
export type ContentLocalizationDraftInput = Static<typeof ContentLocalizationDraftInputSchema>

/** Draft-only editor projection substrate; never substitute projected trees for shared structure. */
export const SiteLocalizationContextSchema = Type.Object({
  fieldLocalizations: Type.Record(Type.String(), Type.Record(Type.String(), FieldLocalizationSchema)),
  rows: Type.Record(Type.String(), Type.Object({
    tableId: Type.Union([Type.Literal('pages'), Type.Literal('components'), Type.Literal('layouts')]),
    sharedCells: CellsSchema,
    localizations: Type.Record(Type.String(), ContentLocalizationDraftInputSchema),
  })),
})
export type SiteLocalizationContext = Static<typeof SiteLocalizationContextSchema>

export const TableLocalizationSchema = Type.Object({
  tableId: Type.String(),
  localeId: Type.String(),
  routeBase: Type.String(),
})
export type TableLocalization = Static<typeof TableLocalizationSchema>
