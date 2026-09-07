import { Type, type Static } from '@core/utils/typeboxHelpers'

export const LanguageSwitcherPropsSchema = Type.Object({
  label: Type.String({ default: 'Language' }),
  display: Type.Union([Type.Literal('name'), Type.Literal('code')], { default: 'name' }),
  showCurrent: Type.Boolean({ default: true }),
  hideIfSingle: Type.Boolean({ default: true }),
})
export type LanguageSwitcherProps = Static<typeof LanguageSwitcherPropsSchema>
