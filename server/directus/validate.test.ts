import { describe, expect, it } from 'bun:test'
import { DirectusError } from './errors'
import { assertNoControlChars, assertUuid, optionalLocale, parseLimit, parsePage } from './validate'

describe('Directus input guards', () => {
  it('rejects a NUL byte so Postgres never sees it', () => {
    expect(() => assertNoControlChars('search', 'brux\u0000elles')).toThrow(DirectusError)
    try {
      assertNoControlChars('search', 'brux\u0000elles')
    } catch (err) {
      expect(err).toBeInstanceOf(DirectusError)
      expect((err as DirectusError).status).toBe(400)
      expect((err as DirectusError).message).toBe("'search' contains control characters")
    }
  })

  it('only accepts the 8 supported locales', () => {
    expect(optionalLocale(null)).toBeUndefined()
    expect(optionalLocale('  ')).toBeUndefined()
    expect(optionalLocale(' nl-BE ')).toBe('nl-BE')
    expect(() => optionalLocale('en')).toThrow(DirectusError)
    expect(() => optionalLocale('en-GB')).toThrow("'locale' must be one of fr-BE, nl-BE, de-BE, en-BE, fr-FR, en-FR, nl-NL, en-NL")
  })

  it('requires a uuid', () => {
    expect(() => assertUuid('geography_id', 'not-a-uuid')).toThrow("'geography_id' must be a uuid")
    expect(() => assertUuid('parent_id', '03af8c53-1111-4111-8111-000000000001')).not.toThrow()
  })

  it('clamps limit to 1..1000', () => {
    expect(parseLimit(null)).toBe(100)
    expect(parseLimit('25')).toBe(25)
    expect(() => parseLimit('0')).toThrow(DirectusError)
    expect(() => parseLimit('1001')).toThrow(DirectusError)
  })

  it('requires a 1-based page', () => {
    expect(parsePage(undefined)).toBe(1)
    expect(() => parsePage('0')).toThrow(DirectusError)
  })
})
