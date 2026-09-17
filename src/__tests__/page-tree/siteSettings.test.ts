/**
 * SiteSettings — `settings.csp` allowlist parsing and origin validation.
 *
 * The allowlist is the only place an owner can let a third-party script
 * origin through the publisher's `script-src 'self'`, so what it accepts
 * matters: exact HTTPS origins (optionally a `*.` wildcard label), never a
 * scheme wildcard, a path, or a CSP keyword. Persisted junk is dropped
 * entry-by-entry rather than failing the whole settings object.
 */
import { describe, it, expect } from 'bun:test'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import {
  SiteCspSettingsSchema,
  isCspOrigin,
  parseCspOriginList,
  parseSiteSettings,
} from '@core/page-tree'

describe('isCspOrigin', () => {
  it.each([
    'https://www.googletagmanager.com',
    'https://connect.facebook.net',
    'https://*.google-analytics.com',
    'https://cdn.example.co.uk:8443',
    'https://a-b.example',
  ])('accepts %s', (origin) => {
    expect(isCspOrigin(origin)).toBe(true)
  })

  it.each([
    'http://www.googletagmanager.com',
    'https://www.googletagmanager.com/gtag/js',
    'https://www.googletagmanager.com/',
    'https://',
    'https://localhost',
    'https:',
    "'unsafe-inline'",
    '*',
    'www.googletagmanager.com',
    'https://*',
    'https://-bad.example',
    'https://user:pw@example.com',
    'https://example.com?x=1',
    ' https://example.com',
  ])('rejects %s', (origin) => {
    expect(isCspOrigin(origin)).toBe(false)
  })
})

describe('parseCspOriginList', () => {
  it('trims, drops blanks and invalid entries, and de-duplicates in first-seen order', () => {
    expect(
      parseCspOriginList([
        '  https://b.example ',
        '',
        'http://nope.example',
        'https://a.example',
        'https://b.example',
        42,
        null,
      ]),
    ).toEqual(['https://b.example', 'https://a.example'])
  })

  it('returns [] for non-arrays', () => {
    expect(parseCspOriginList(undefined)).toEqual([])
    expect(parseCspOriginList('https://a.example')).toEqual([])
    expect(parseCspOriginList({ 0: 'https://a.example' })).toEqual([])
  })
})

describe('parseSiteSettings — csp', () => {
  it('keeps a valid allowlist', () => {
    const settings = parseSiteSettings({
      shortcuts: {},
      csp: {
        scriptOrigins: ['https://www.googletagmanager.com'],
        connectOrigins: ['https://www.google-analytics.com'],
      },
    })
    expect(settings.csp).toEqual({
      scriptOrigins: ['https://www.googletagmanager.com'],
      connectOrigins: ['https://www.google-analytics.com'],
    })
    expect(compiledCheck(SiteCspSettingsSchema, settings.csp)).toBe(true)
  })

  it('drops invalid entries without failing the rest of the settings', () => {
    const settings = parseSiteSettings({
      metaTitle: 'Kept',
      shortcuts: {},
      csp: {
        scriptOrigins: ['https://ok.example', "'unsafe-inline'", 'javascript:alert(1)'],
        connectOrigins: 'https://not-an-array.example',
      },
    })
    expect(settings.metaTitle).toBe('Kept')
    expect(settings.csp).toEqual({ scriptOrigins: ['https://ok.example'], connectOrigins: [] })
  })

  it('omits csp entirely when nothing valid remains or the field is malformed', () => {
    expect(parseSiteSettings({ shortcuts: {}, csp: { scriptOrigins: [], connectOrigins: [] } }).csp)
      .toBeUndefined()
    expect(parseSiteSettings({ shortcuts: {}, csp: ['https://a.example'] }).csp).toBeUndefined()
    expect(parseSiteSettings({ shortcuts: {} }).csp).toBeUndefined()
    expect('csp' in parseSiteSettings({ shortcuts: {} })).toBe(false)
  })

  it('schema rejects a raw list carrying a non-origin', () => {
    expect(
      compiledCheck(SiteCspSettingsSchema, {
        scriptOrigins: ['https://ok.example', 'http://nope.example'],
        connectOrigins: [],
      }),
    ).toBe(false)
  })
})
