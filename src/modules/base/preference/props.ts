import { Type, type Static } from '@core/utils/typeboxHelpers'
import { VisitorPreferenceNameSchema, SiteVisitorPreferencesSchema } from '@core/visitor-preferences-schema'

export const PreferencePropsSchema = Type.Object({
  preference: Type.Union(VisitorPreferenceNameSchema.anyOf, { default: 'theme' }),
  label: Type.String({ default: 'Appearance' }),
  systemLabel: Type.String({ default: 'Use system preference' }),
  defaultLabel: Type.String({ default: 'Default palette' }),
  altLabel: Type.String({ default: 'Alternate palette' }),
  fullLabel: Type.String({ default: 'Full media' }),
  reducedLabel: Type.String({ default: 'Reduced' }),
  defaultStatus: Type.String({ default: 'Using the site defaults.' }),
  savedStatus: Type.String({ default: 'Preferences saved in this browser.' }),
  sessionStatus: Type.String({ default: 'This change applies to this page only; browser storage is unavailable.' }),
  resetStatus: Type.String({ default: 'Invalid saved preferences were removed; using the site defaults.' }),
  unavailableStatus: Type.String({ default: 'Saved preferences could not be read. New changes may apply to this page only.' }),
  previewStatus: Type.String({ default: 'Preview only; preferences are not saved.' }),
  invalidStatus: Type.String({ default: 'This preference could not be applied.' }),
})

const CaptionSchema = Type.String({ minLength: 1, pattern: '\\S' })
export const PreferencePublishSchema = Type.Intersect([
  Type.Object({ settings: Type.Object({ visitorPreferences: SiteVisitorPreferencesSchema }) }),
  Type.Object({ props: Type.Object({
    label: CaptionSchema, defaultStatus: CaptionSchema, savedStatus: CaptionSchema,
    sessionStatus: CaptionSchema, resetStatus: CaptionSchema, unavailableStatus: CaptionSchema,
    previewStatus: CaptionSchema, invalidStatus: CaptionSchema,
  }) }),
  Type.Union([
    Type.Object({ props: Type.Object({ preference: Type.Literal('theme'), systemLabel: CaptionSchema, defaultLabel: CaptionSchema, altLabel: CaptionSchema }) }),
    Type.Object({ props: Type.Object({ preference: Type.Literal('motion'), systemLabel: CaptionSchema, reducedLabel: CaptionSchema }) }),
    Type.Object({ props: Type.Object({ preference: Type.Literal('media'), fullLabel: CaptionSchema, reducedLabel: CaptionSchema }) }),
  ], { description: 'Preference controls require authored labels for every displayed choice.' }),
])
export type PreferenceStoredProps = Static<typeof PreferencePropsSchema>

export function preferenceChoices(props: PreferenceStoredProps) {
  if (props.preference === 'theme') return [
    { value: 'system', label: props.systemLabel }, { value: 'default', label: props.defaultLabel }, { value: 'alt', label: props.altLabel },
  ]
  if (props.preference === 'motion') return [
    { value: 'system', label: props.systemLabel }, { value: 'reduced', label: props.reducedLabel },
  ]
  return [{ value: 'full', label: props.fullLabel }, { value: 'reduced', label: props.reducedLabel }]
}

export function preferenceCaptions(props: PreferenceStoredProps) {
  return {
    default: props.defaultStatus, saved: props.savedStatus, session: props.sessionStatus,
    reset: props.resetStatus, unavailable: props.unavailableStatus,
    preview: props.previewStatus, invalid: props.invalidStatus,
  }
}
