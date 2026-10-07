import { Type, type Static } from '@core/utils/typeboxHelpers'

/** Language dictionaries contain text, not component trees or executable code. */
export const TranslationMessagesSchema = Type.Recursive((Self) =>
  Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]*$' }),
    Type.Union([Type.String(), Self]), { additionalProperties: false }),
)
export type TranslationMessages = Static<typeof TranslationMessagesSchema>

export const LanguageCatalogueSchema = Type.Object({
  language: Type.String({ minLength: 1 }),
  messages: TranslationMessagesSchema,
}, { additionalProperties: false })
export type LanguageCatalogue = Static<typeof LanguageCatalogueSchema>

export const SiteLocalizationSettingsSchema = Type.Object({
  catalogues: Type.Array(Type.Object({
    language: Type.String({ minLength: 1 }),
    fileId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false })
export type SiteLocalizationSettings = Static<typeof SiteLocalizationSettingsSchema>
