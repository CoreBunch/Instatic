import { Type, type Static } from '@core/utils/typeboxHelpers'
import { TranslationMessagesSchema } from '@core/localization-schema'

/** Data authoring projections expose catalogue text, never source SiteFiles. */
const DataLocalizationMetadataProps = {
  languages: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  canBrowseCatalogue: Type.Boolean(),
}
export const DataLocalizationSchema = Type.Union([
  Type.Object({ ...DataLocalizationMetadataProps, language: Type.Optional(Type.Never()), translations: Type.Optional(Type.Never()) }, { additionalProperties: false }),
  Type.Object({ ...DataLocalizationMetadataProps, language: Type.String({ minLength: 1 }), translations: TranslationMessagesSchema }, { additionalProperties: false }),
])
export type DataLocalization = Static<typeof DataLocalizationSchema>
