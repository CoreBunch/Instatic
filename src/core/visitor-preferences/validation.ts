import {
  VisitorPreferenceNameSchema,
  VisitorPreferenceOverridesSchema,
  VisitorPreferencesRuntimeConfigSchema,
} from '@core/visitor-preferences-schema'
import { compiled } from '@core/utils/typeboxCompiler'
import type { VisitorPreferencesValidators } from './runtime'

const config = compiled(VisitorPreferencesRuntimeConfigSchema)
const overrides = compiled(VisitorPreferenceOverridesSchema)
const name = compiled(VisitorPreferenceNameSchema)

/** The browser receives static code generated from these same TypeBox schemas. */
export const visitorPreferencesValidators: VisitorPreferencesValidators = {
  config: value => config.Check(value),
  overrides: value => overrides.Check(value),
  name: value => name.Check(value),
}

export const visitorPreferencesValidatorCode = {
  config: config.Code(),
  overrides: overrides.Code(),
  name: name.Code(),
}
