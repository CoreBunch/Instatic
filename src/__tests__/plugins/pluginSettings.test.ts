/**
 * Tests for the plugin settings SDK helpers.
 *
 * The secret-value semantics (encrypt at rest, `'***'` sentinel
 * preserve / rotate / clear) live at the persistence boundary and are
 * covered by `src/__tests__/server/pluginSecrets.test.ts` and
 * `cmsPlugins.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import {
  pluginSettingsDefaults,
  validatePluginSettingsDefinitions,
  validatePluginSettingsRecord,
  type PluginSettingDefinition,
} from '@core/plugin-sdk'

const baseSchema: PluginSettingDefinition[] = [
  { id: 'apiKey', label: 'API key', type: 'password', secret: true, default: '' },
  { id: 'enabled', label: 'Enabled', type: 'toggle', default: true },
  { id: 'count', label: 'Count', type: 'number', default: 5, min: 0, max: 100 },
  {
    id: 'theme',
    label: 'Theme',
    type: 'select',
    default: 'light',
    options: [
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
    ],
  },
  { id: 'requiredField', label: 'Required field', type: 'text', required: true },
]

describe('pluginSettingsDefaults', () => {
  it('populates defaults declared in the schema', () => {
    const defaults = pluginSettingsDefaults(baseSchema)
    expect(defaults).toEqual({
      apiKey: '',
      enabled: true,
      count: 5,
      theme: 'light',
      requiredField: '',
    })
  })

  it('chooses sensible fallbacks when default is omitted', () => {
    const defaults = pluginSettingsDefaults([
      { id: 'a', label: 'A', type: 'text' },
      { id: 'b', label: 'B', type: 'toggle' },
      { id: 'c', label: 'C', type: 'number' },
    ])
    expect(defaults).toEqual({ a: '', b: false, c: 0 })
  })
})

describe('validatePluginSettingsRecord', () => {
  it('accepts a record matching the schema', () => {
    const cleaned = validatePluginSettingsRecord(baseSchema, {
      apiKey: 'secret',
      enabled: false,
      count: 10,
      theme: 'dark',
      requiredField: 'x',
    })
    expect(cleaned).toEqual({
      apiKey: 'secret',
      enabled: false,
      count: 10,
      theme: 'dark',
      requiredField: 'x',
    })
  })

  it('rejects values that violate type expectations', () => {
    expect(() => validatePluginSettingsRecord(baseSchema, {
      enabled: 'yes',
      requiredField: 'x',
    })).toThrow(/must be a boolean/)
    expect(() => validatePluginSettingsRecord(baseSchema, {
      count: 'lots',
      requiredField: 'x',
    })).toThrow(/must be a number/)
    expect(() => validatePluginSettingsRecord(baseSchema, {
      theme: 'neon',
      requiredField: 'x',
    })).toThrow(/must be one of/)
  })

  it('rejects out-of-range numbers', () => {
    expect(() => validatePluginSettingsRecord(baseSchema, {
      count: 200,
      requiredField: 'x',
    })).toThrow(/at most 100/)
    expect(() => validatePluginSettingsRecord(baseSchema, {
      count: -1,
      requiredField: 'x',
    })).toThrow(/at least 0/)
  })

  it('throws when a required field is missing', () => {
    expect(() => validatePluginSettingsRecord(baseSchema, { enabled: true })).toThrow(/required/)
  })

  it('drops unknown keys from input', () => {
    const cleaned = validatePluginSettingsRecord(baseSchema, {
      requiredField: 'x',
      ignoreMe: 'gone',
    })
    expect(cleaned).not.toHaveProperty('ignoreMe')
  })
})

describe('validatePluginSettingsDefinitions', () => {
  it('rejects duplicate setting ids at definePlugin-time', () => {
    expect(() =>
      validatePluginSettingsDefinitions('acme.x', [
        { id: 'a', label: 'A', type: 'text' },
        { id: 'a', label: 'A again', type: 'text' },
      ]),
    ).toThrow(/duplicate setting id/)
  })

  it('rejects invalid setting ids', () => {
    expect(() =>
      validatePluginSettingsDefinitions('acme.x', [
        { id: '1invalid', label: 'X', type: 'text' },
      ]),
    ).toThrow(/invalid/)
  })

  it('rejects secret on non-string setting types (secrets are encrypted as strings)', () => {
    expect(() =>
      validatePluginSettingsDefinitions('acme.x', [
        { id: 'flag', label: 'Flag', type: 'toggle', secret: true },
      ]),
    ).toThrow(/cannot be secret/)
    expect(() =>
      validatePluginSettingsDefinitions('acme.x', [
        { id: 'limit', label: 'Limit', type: 'number', secret: true },
      ]),
    ).toThrow(/cannot be secret/)
    expect(() =>
      validatePluginSettingsDefinitions('acme.x', [
        { id: 'apiKey', label: 'API key', type: 'password', secret: true },
      ]),
    ).not.toThrow()
  })
})
