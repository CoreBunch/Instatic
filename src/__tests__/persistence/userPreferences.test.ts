import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_MODULE_INSERTER_PREFERENCE,
  USER_PREFERENCE_KEYS,
  USER_PREFERENCE_SCHEMAS,
} from '@core/persistence/userPreferences'
import { parseValue, safeParseValue } from '@core/utils/typeboxHelpers'

describe('user preference schemas', () => {
  it('whitelists the module inserter preference key', () => {
    expect(USER_PREFERENCE_KEYS).toContain('module-inserter')
  })

  it('validates module inserter favorites as ordered inserter refs', () => {
    const parsed = parseValue(USER_PREFERENCE_SCHEMAS['module-inserter'], {
      favorites: [
        { kind: 'module', id: 'base.text' },
        { kind: 'savedLayout', id: 'layout.contact' },
        { kind: 'component', id: 'vc.hero' },
      ],
    })

    expect(parsed).toEqual({
      favorites: [
        { kind: 'module', id: 'base.text' },
        { kind: 'savedLayout', id: 'layout.contact' },
        { kind: 'component', id: 'vc.hero' },
      ],
    })
  })

  it('rejects malformed module inserter favorite refs', () => {
    expect(
      safeParseValue(USER_PREFERENCE_SCHEMAS['module-inserter'], {
        favorites: [{ kind: 'module', id: 123 }],
      }).ok,
    ).toBe(false)
  })

  it('defaults notch favorites to Container, Text, and Image', () => {
    expect(DEFAULT_MODULE_INSERTER_PREFERENCE).toEqual({
      favorites: [
        { kind: 'module', id: 'base.container' },
        { kind: 'module', id: 'base.text' },
        { kind: 'module', id: 'base.image' },
      ],
    })
  })
})

describe('editor-tour preference', () => {
  it('whitelists the editor tour preference key', () => {
    expect(USER_PREFERENCE_KEYS).toContain('editor-tour')
  })

  it('accepts a completed status', () => {
    expect(parseValue(USER_PREFERENCE_SCHEMAS['editor-tour'], { status: 'completed' })).toEqual({
      status: 'completed',
    })
  })

  it('accepts a dismissed status', () => {
    expect(parseValue(USER_PREFERENCE_SCHEMAS['editor-tour'], { status: 'dismissed' })).toEqual({
      status: 'dismissed',
    })
  })

  it('rejects an unknown status', () => {
    expect(safeParseValue(USER_PREFERENCE_SCHEMAS['editor-tour'], { status: 'seen' }).ok).toBe(
      false,
    )
  })

  it('rejects a missing status', () => {
    expect(safeParseValue(USER_PREFERENCE_SCHEMAS['editor-tour'], {}).ok).toBe(false)
  })
})
