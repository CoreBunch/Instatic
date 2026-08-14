import { describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import { USER_PREFERENCE_KEYS, USER_PREFERENCE_SCHEMAS } from './userPreferences'

describe('editor-tour preference', () => {
  it('is whitelisted with a schema', () => {
    expect(USER_PREFERENCE_KEYS).toContain('editor-tour')
    expect(USER_PREFERENCE_SCHEMAS['editor-tour']).toBeDefined()
  })
  it('accepts completed/dismissed, rejects anything else', () => {
    const schema = USER_PREFERENCE_SCHEMAS['editor-tour']
    expect(Value.Check(schema, { status: 'completed' })).toBe(true)
    expect(Value.Check(schema, { status: 'dismissed' })).toBe(true)
    expect(Value.Check(schema, { status: 'seen' })).toBe(false)
    expect(Value.Check(schema, {})).toBe(false)
  })
})
