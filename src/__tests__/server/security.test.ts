import { afterEach, describe, expect, it } from 'bun:test'
import {
  DEV_ORIGIN_ALLOWLIST,
  clientIp,
  configurePublicOrigins,
  configureTrustedProxyCidrs,
  expectedOrigin,
  isStateChangingMethod,
  originAllowed,
  publicOriginIsHttps,
  resetPublicOrigins,
  resetTrustedProxyCidrs,
  stampSocketIp,
} from '../../../server/auth/security'

/**
 * Build a Request whose headers contain Fetch-spec "forbidden header names"
 * (Origin, Host, Cookie, etc.) — happy-dom (loaded by the test setup) strips
 * these when set via the Request constructor's `headers` init, but they
 * absolutely DO arrive on the wire when the production Bun.serve receives a
 * real HTTP request. We mutate the Headers object after construction; both
 * happy-dom and Bun's native Request allow that path.
 */
function makeReq(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const req = new Request(url, { method: init.method ?? 'GET' })
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    req.headers.set(k, v)
  }
  return req
}

afterEach(() => {
  resetTrustedProxyCidrs()
  resetPublicOrigins()
})

describe('isStateChangingMethod', () => {
  it.each([
    ['POST', true],
    ['PUT', true],
    ['PATCH', true],
    ['DELETE', true],
    ['GET', false],
    ['HEAD', false],
    ['OPTIONS', false],
  ] as const)('%s → %s', (method, expected) => {
    expect(isStateChangingMethod(method)).toBe(expected)
  })
})

describe('expectedOrigin', () => {
  it('returns the configured canonical public origin', () => {
    configurePublicOrigins(['https://cms.example.com'])
    const req = makeReq('http://app:3001/admin/api/cms/login', { method: 'POST' })
    expect(expectedOrigin(req)).toBe('https://cms.example.com')
  })

  it('returns the first configured public origin when several are set', () => {
    configurePublicOrigins(['https://cms.example.com', 'https://www.example.com'])
    const req = makeReq('http://app:3001/admin/api/cms/login', { method: 'POST' })
    expect(expectedOrigin(req)).toBe('https://cms.example.com')
  })

  it('IGNORES a spoofed X-Forwarded-Host/Proto even from a trusted proxy peer', () => {
    configurePublicOrigins(['https://cms.example.com'])
    configureTrustedProxyCidrs(['172.16.0.0/12'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example.com',
      },
    })
    stampSocketIp(req, '172.18.0.4')
    expect(expectedOrigin(req)).toBe('https://cms.example.com')
  })

  it('falls back to the Host header (with the req.url scheme) when nothing is configured', () => {
    const req = makeReq('http://internal:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { host: 'cms.example.com' },
    })
    expect(expectedOrigin(req)).toBe('http://cms.example.com')
  })

  it('falls back to the request URL when no public origin and no Host header are present', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', { method: 'POST' })
    expect(expectedOrigin(req)).toBe('http://localhost:3001')
  })

  it('does not consult forwarded headers in the fallback path either', () => {
    configureTrustedProxyCidrs(['172.16.0.0/12'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: {
        host: 'app:3001',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'cms.example.com',
      },
    })
    stampSocketIp(req, '172.18.0.4')
    expect(expectedOrigin(req)).toBe('http://app:3001')
  })
})

describe('publicOriginIsHttps', () => {
  it('is true when the canonical public origin is https', () => {
    configurePublicOrigins(['https://cms.example.com'])
    expect(publicOriginIsHttps()).toBe(true)
  })

  it('is false when the canonical public origin is http', () => {
    configurePublicOrigins(['http://cms.example.com'])
    expect(publicOriginIsHttps()).toBe(false)
  })

  it('is false when nothing is configured', () => {
    expect(publicOriginIsHttps()).toBe(false)
  })
})

describe('originAllowed', () => {
  it('allows requests with no Origin header (curl, server-to-server)', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', { method: 'POST' })
    expect(originAllowed(req)).toBe(true)
  })

  it('allows requests whose Origin matches the configured public origin', () => {
    configurePublicOrigins(['https://cms.example.com'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { origin: 'https://cms.example.com' },
    })
    expect(originAllowed(req)).toBe(true)
  })

  it('matches against MULTIPLE configured origins (custom + platform domain both pass)', () => {
    configurePublicOrigins(['https://app.onrender.com', 'https://www.example.com'])
    const platform = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { origin: 'https://app.onrender.com' },
    })
    const custom = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { origin: 'https://www.example.com' },
    })
    expect(originAllowed(platform)).toBe(true)
    expect(originAllowed(custom)).toBe(true)
  })

  it('normalizes both sides so a trailing slash / case difference still matches', () => {
    configurePublicOrigins(['https://cms.example.com'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { origin: 'https://CMS.example.com/' },
    })
    expect(originAllowed(req)).toBe(true)
  })

  it('allows requests from the localhost dev origin (Vite at :5173)', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(originAllowed(req)).toBe(true)
  })

  it('uses the same dev origins for CSRF and CORS checks', () => {
    expect(DEV_ORIGIN_ALLOWLIST).toContain('http://localhost:5173')
    expect(DEV_ORIGIN_ALLOWLIST).toContain('http://127.0.0.1:5173')
  })

  it('rejects requests from a foreign origin', () => {
    configurePublicOrigins(['https://cms.example.com'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    })
    expect(originAllowed(req)).toBe(false)
  })

  it('rejects an Origin that only matches a spoofed X-Forwarded-Host from a trusted proxy', () => {
    configurePublicOrigins(['https://cms.example.com'])
    configureTrustedProxyCidrs(['172.16.0.0/12'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example.com',
        origin: 'https://evil.example.com',
      },
    })
    stampSocketIp(req, '172.18.0.4')
    expect(originAllowed(req)).toBe(false)
  })

  it('falls back to the Host header when no public origin is configured', () => {
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { host: 'cms.example.com', origin: 'http://cms.example.com' },
    })
    expect(originAllowed(req)).toBe(true)
  })
})

describe('clientIp', () => {
  it('reads the nearest untrusted XFF entry when the socket peer is trusted', () => {
    configureTrustedProxyCidrs(['10.0.0.0/8'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    })
    stampSocketIp(req, '10.0.0.99')
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('returns null when no XFF header and no socket-IP stamp are present', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', { method: 'POST' })
    expect(clientIp(req)).toBeNull()
  })

  it('trims whitespace around XFF entries', () => {
    configureTrustedProxyCidrs(['10.0.0.0/8'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '  192.0.2.5  , 10.0.0.1' },
    })
    stampSocketIp(req, '10.0.0.99')
    expect(clientIp(req)).toBe('192.0.2.5')
  })

  it('falls back to the Bun socket-IP stamp when XFF is absent', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', { method: 'POST' })
    stampSocketIp(req, '127.0.0.1')
    expect(clientIp(req)).toBe('127.0.0.1')
  })

  it('uses XFF over the socket-IP stamp only when the socket peer is trusted', () => {
    configureTrustedProxyCidrs(['10.0.0.0/8'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    stampSocketIp(req, '10.0.0.99')
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('ignores a spoofed leftmost XFF entry preserved by a trusted proxy', () => {
    configureTrustedProxyCidrs(['10.0.0.0/8'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.200, 203.0.113.7' },
    })
    stampSocketIp(req, '10.0.0.99')
    expect(clientIp(req)).toBe('203.0.113.7')
  })

  it('ignores spoofed XFF from an untrusted direct client', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    stampSocketIp(req, '198.51.100.9')
    expect(clientIp(req)).toBe('198.51.100.9')
  })

  it('is unaffected by configured public origins (CSRF and attribution are independent)', () => {
    configurePublicOrigins(['https://cms.example.com'])
    configureTrustedProxyCidrs(['10.0.0.0/8'])
    const req = makeReq('http://app:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    })
    stampSocketIp(req, '10.0.0.99')
    expect(clientIp(req)).toBe('203.0.113.7')
  })
})

describe('stampSocketIp', () => {
  it('writes the address into a synthetic header that clientIp can read', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', { method: 'POST' })
    stampSocketIp(req, '::1')
    expect(clientIp(req)).toBe('::1')
  })

  it('clears the stamp when the address is null (no peer surfaced)', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', { method: 'POST' })
    stampSocketIp(req, '127.0.0.1')
    stampSocketIp(req, null)
    expect(clientIp(req)).toBeNull()
  })

  it('strips any inbound spoof of the synthetic header before stamping', () => {
    // A malicious client tries to inject the synthetic header. The boundary
    // must overwrite it with the real peer address (here we model that by
    // passing the real value into stampSocketIp).
    const req = makeReq('http://localhost:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-bun-socket-ip': '198.51.100.1' },
    })
    stampSocketIp(req, '127.0.0.1')
    expect(clientIp(req)).toBe('127.0.0.1')
  })

  it('strips any inbound spoof even when no real peer is available', () => {
    const req = makeReq('http://localhost:3001/admin/api/cms/login', {
      method: 'POST',
      headers: { 'x-bun-socket-ip': '198.51.100.1' },
    })
    stampSocketIp(req, null)
    expect(clientIp(req)).toBeNull()
  })
})
