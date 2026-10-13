import { Type, Value, type Static } from '@core/utils/typeboxHelpers'

export const VisitorThemeSchema = Type.Union([
  Type.Literal('system'), Type.Literal('default'), Type.Literal('alt'),
], { default: 'system' })
export const VisitorMotionSchema = Type.Union([
  Type.Literal('system'), Type.Literal('reduced'),
], { default: 'system' })
export const VisitorMediaSchema = Type.Union([
  Type.Literal('full'), Type.Literal('reduced'),
], { default: 'full' })

/** Authored defaults; visitor selections are separate, optional overrides. */
export const SiteVisitorPreferencesSchema = Type.Object({
  theme: VisitorThemeSchema,
  motion: VisitorMotionSchema,
  media: VisitorMediaSchema,
}, { additionalProperties: false })

export const VisitorPreferenceOverridesSchema = Type.Partial(SiteVisitorPreferencesSchema, {
  additionalProperties: false,
})
export const VisitorPreferenceNameSchema = Type.KeyOf(SiteVisitorPreferencesSchema)

export const VisitorPreferencesRuntimeConfigSchema = Type.Object({
  defaults: SiteVisitorPreferencesSchema,
  storage: Type.Union([Type.Literal('persistent'), Type.Literal('memory')]),
}, { additionalProperties: false })

export type SiteVisitorPreferences = Static<typeof SiteVisitorPreferencesSchema>
export type VisitorPreferenceOverrides = Static<typeof VisitorPreferenceOverridesSchema>
export type VisitorPreferencesRuntimeConfig = Static<typeof VisitorPreferencesRuntimeConfigSchema>
export type VisitorPreferenceName = Static<typeof VisitorPreferenceNameSchema>

export const DEFAULT_SITE_VISITOR_PREFERENCES: SiteVisitorPreferences = Value.Create(SiteVisitorPreferencesSchema)

export class VisitorPreferencesValidationError extends Error {
  readonly path: string
  constructor(path: string) {
    super(path + ': Invalid visitor preferences')
    this.name = 'VisitorPreferencesValidationError'
    this.path = path
  }
}
