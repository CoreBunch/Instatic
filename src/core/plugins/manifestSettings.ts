/**
 * The schema of a plugin manifest's `settings[]`: one variant per setting
 * type. Split out of `manifest.ts`, which assembles the whole manifest
 * schema and reads this for its `settings` field.
 */
import { Type } from '@core/utils/typeboxHelpers'

// `settings` schema — a discriminated union over the supported types, mirroring
// `PluginSettingDefinition` in `src/core/plugin-sdk/builders/settings.ts`.
// The Static type of each variant is assignment-compatible with the
// corresponding `PluginSettingDefinition` branch (Array<T> extends
// ReadonlyArray<T>), so parsePluginManifest needs no cast for `settings`.
const SETTING_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/

// Base properties shared by every setting variant.
const settingBaseProps = {
  id: Type.String({ pattern: SETTING_ID_PATTERN.source }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  required: Type.Optional(Type.Boolean()),
  secret: Type.Optional(Type.Boolean()),
}

const settingOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  value: Type.String({ minLength: 1, maxLength: 80 }),
})

export const settingDefinitionSchema = Type.Union([
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('text'),
    placeholder: Type.Optional(Type.String({ maxLength: 120 })),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('textarea'),
    placeholder: Type.Optional(Type.String({ maxLength: 120 })),
    rows: Type.Optional(Type.Number({ minimum: 1 })),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('number'),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
    step: Type.Optional(Type.Number()),
    unit: Type.Optional(Type.String({ maxLength: 16 })),
    default: Type.Optional(Type.Number()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('toggle'),
    default: Type.Optional(Type.Boolean()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('select'),
    // Required field — a select setting must declare its options.
    options: Type.Array(settingOptionSchema, { minItems: 1 }),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('color'),
    format: Type.Optional(Type.Union([Type.Literal('hex'), Type.Literal('rgba')])),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('url'),
    default: Type.Optional(Type.String()),
  }),
  Type.Object({
    ...settingBaseProps,
    type: Type.Literal('password'),
    placeholder: Type.Optional(Type.String({ maxLength: 120 })),
    default: Type.Optional(Type.String()),
  }),
])
