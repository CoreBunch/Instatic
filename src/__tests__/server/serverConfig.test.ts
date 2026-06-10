import { describe, expect, it } from 'bun:test'
import { normalizeOrigin, resolvePublicOrigins } from '../../../server/config'

describe('normalizeOrigin', () => {
  it('lowercases scheme and host and strips the trailing slash', () => {
    expect(normalizeOrigin('HTTPS://CMS.Example.com/')).toBe('https://cms.example.com')
  })

  it('strips path, query, and fragment', () => {
    expect(normalizeOrigin('https://cms.example.com/admin?x=1#frag')).toBe('https://cms.example.com')
  })

  it('keeps an explicit non-default port', () => {
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173')
  })

  it('drops a default port (URL normalizes it away)', () => {
    expect(normalizeOrigin('https://cms.example.com:443')).toBe('https://cms.example.com')
  })

  it('returns null for a bare host with no scheme', () => {
    expect(normalizeOrigin('cms.example.com')).toBeNull()
  })

  it('returns null for garbage', () => {
    expect(normalizeOrigin('not a url')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin('   ')).toBeNull()
  })
})

describe('resolvePublicOrigins', () => {
  it('parses a comma-separated PUBLIC_ORIGIN list and normalizes each entry', () => {
    expect(
      resolvePublicOrigins({
        PUBLIC_ORIGIN: 'https://CMS.example.com/, http://localhost:5173',
      }),
    ).toEqual(['https://cms.example.com', 'http://localhost:5173'])
  })

  it('drops invalid PUBLIC_ORIGIN entries but keeps valid ones', () => {
    expect(
      resolvePublicOrigins({
        PUBLIC_ORIGIN: 'https://cms.example.com, not-a-url, ',
      }),
    ).toEqual(['https://cms.example.com'])
  })

  it('deduplicates entries that normalize to the same origin', () => {
    expect(
      resolvePublicOrigins({
        PUBLIC_ORIGIN: 'https://cms.example.com, https://CMS.example.com/',
      }),
    ).toEqual(['https://cms.example.com'])
  })

  it('falls back to RENDER_EXTERNAL_URL when PUBLIC_ORIGIN is unset', () => {
    expect(resolvePublicOrigins({ RENDER_EXTERNAL_URL: 'https://app.onrender.com' })).toEqual([
      'https://app.onrender.com',
    ])
  })

  it('falls back to https://RAILWAY_PUBLIC_DOMAIN when PUBLIC_ORIGIN is unset', () => {
    expect(resolvePublicOrigins({ RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' })).toEqual([
      'https://app.up.railway.app',
    ])
  })

  it('combines both platform vars when both are present', () => {
    expect(
      resolvePublicOrigins({
        RENDER_EXTERNAL_URL: 'https://app.onrender.com',
        RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app',
      }),
    ).toEqual(['https://app.onrender.com', 'https://app.up.railway.app'])
  })

  it('lets PUBLIC_ORIGIN win over platform vars', () => {
    expect(
      resolvePublicOrigins({
        PUBLIC_ORIGIN: 'https://www.example.com',
        RENDER_EXTERNAL_URL: 'https://app.onrender.com',
        RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app',
      }),
    ).toEqual(['https://www.example.com'])
  })

  it('returns [] when nothing is configured', () => {
    expect(resolvePublicOrigins({})).toEqual([])
  })
})
