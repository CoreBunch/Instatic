import { describe, expect, it } from 'bun:test'
import { normalizeOrigin, readServerConfig, resolvePublicOrigins } from '../../../server/config'

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

describe('readServerConfig', () => {
  it('uses self-hosted local defaults when no environment values are set', () => {
    expect(readServerConfig({})).toEqual({
      port: 3001,
      databaseUrl: 'sqlite:./.tmp/dev.db',
      uploadsDir: './uploads',
      staticDir: './dist',
      trustedProxyCidrs: [],
      publicOrigins: [],
      platform: {
        enabled: true,
        databaseUrl: 'sqlite:./.tmp/control-plane.db',
        authMode: 'development',
        workos: null,
        cookieSecure: false,
        appUrl: 'http://localhost:5173',
        developmentIdentity: {
          userId: 'user_local_owner',
          email: 'owner@local.instatic',
          name: 'Local Owner',
          organizationId: 'org_local_agency',
          organizationName: 'Local Agency',
        },
      },
    })
  })

  it('reads runtime paths, port, trusted proxies, and public origins from env', () => {
    expect(
      readServerConfig({
        PORT: '4321',
        DATABASE_URL: 'postgres://instatic:secret@postgres:5432/instatic',
        UPLOADS_DIR: '/srv/instatic/uploads',
        STATIC_DIR: '/srv/instatic/dist',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 192.168.0.0/16, ',
        PUBLIC_ORIGIN: 'https://CMS.example.com/, http://localhost:5173',
        RENDER_EXTERNAL_URL: 'https://ignored.onrender.com',
        RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app',
      }),
    ).toEqual({
      port: 4321,
      databaseUrl: 'postgres://instatic:secret@postgres:5432/instatic',
      uploadsDir: '/srv/instatic/uploads',
      staticDir: '/srv/instatic/dist',
      trustedProxyCidrs: ['10.0.0.0/8', '192.168.0.0/16'],
      publicOrigins: ['https://cms.example.com', 'http://localhost:5173'],
      platform: {
        enabled: true,
        databaseUrl: 'sqlite:./.tmp/control-plane.db',
        authMode: 'development',
        workos: null,
        cookieSecure: true,
        appUrl: 'https://cms.example.com',
        developmentIdentity: {
          userId: 'user_local_owner',
          email: 'owner@local.instatic',
          name: 'Local Owner',
          organizationId: 'org_local_agency',
          organizationName: 'Local Agency',
        },
      },
    })
  })
})
