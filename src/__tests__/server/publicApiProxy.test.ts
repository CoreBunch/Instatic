import { describe, expect, it } from 'bun:test'
import { handlePublicApiProxy } from '../../../server/publicApiProxy'

const proxyUrl = 'http://bchvac-api.railway.internal:8080'

function request(path: string, init: RequestInit = {}): Request {
  const suppliedOrigin = new Headers(init.headers).get('origin')
  const req = new Request(`https://berniesheating.com${path}`, init)
  if (init.method === 'POST') {
    req.headers.set('origin', suppliedOrigin ?? 'https://berniesheating.com')
  }
  return req
}

describe('public API reverse proxy', () => {
  it('forwards only the allowlisted weather route to the private service', async () => {
    let forwarded: Request | null = null
    const response = await handlePublicApiProxy(
      request('/api/weather?units=imperial'),
      new URL('https://berniesheating.com/api/weather?units=imperial'),
      {
        baseUrl: proxyUrl,
        fetch: async (upstream) => {
          forwarded = upstream instanceof Request ? upstream : new Request(upstream)
          return Response.json({ temperature: 72 }, {
            headers: { 'cache-control': 'public, max-age=300' },
          })
        },
      },
    )

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ temperature: 72 })
    expect(forwarded?.url).toBe(`${proxyUrl}/api/weather?units=imperial`)
    expect(forwarded?.headers.get('origin')).toBe('https://berniesheating.com')
    expect(response?.headers.get('cache-control')).toBe('public, max-age=300')
  })

  it('forwards an allowlisted JSON POST without cookies or authorization', async () => {
    let forwarded: Request | null = null
    const response = await handlePublicApiProxy(
      request('/api/contact', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'instatic-session=secret',
          authorization: 'Bearer secret',
        },
        body: JSON.stringify({ name: 'Test' }),
      }),
      new URL('https://berniesheating.com/api/contact'),
      {
        baseUrl: proxyUrl,
        clientIp: '203.0.113.8',
        fetch: async (upstream) => {
          forwarded = upstream instanceof Request ? upstream : new Request(upstream)
          return Response.json({ success: true })
        },
      },
    )

    expect(response?.status).toBe(200)
    expect(forwarded?.method).toBe('POST')
    expect(await forwarded?.json()).toEqual({ name: 'Test' })
    expect(forwarded?.headers.get('content-type')).toBe('application/json')
    expect(forwarded?.headers.get('x-forwarded-for')).toBe('203.0.113.8')
    expect(forwarded?.headers.has('cookie')).toBe(false)
    expect(forwarded?.headers.has('authorization')).toBe(false)
  })

  it('rejects cross-origin POSTs before calling the private service', async () => {
    let called = false
    const response = await handlePublicApiProxy(
      request('/api/livekit/connection-details', {
        method: 'POST',
        headers: { origin: 'https://attacker.example' },
      }),
      new URL('https://berniesheating.com/api/livekit/connection-details'),
      {
        baseUrl: proxyUrl,
        fetch: async () => {
          called = true
          return new Response()
        },
      },
    )

    expect(response?.status).toBe(403)
    expect(called).toBe(false)
  })

  it('uses configured public origins when the platform presents an internal request URL', async () => {
    let upstreamOrigin: string | null = null
    const response = await handlePublicApiProxy(
      request('/api/livekit/connection-details', { method: 'POST', body: '{}' }),
      new URL('http://0.0.0.0:8080/api/livekit/connection-details'),
      {
        baseUrl: proxyUrl,
        publicOrigins: ['https://berniesheating.com'],
        fetch: async (upstream) => {
          const forwarded = upstream instanceof Request ? upstream : new Request(upstream)
          upstreamOrigin = forwarded.headers.get('origin')
          return Response.json({ serverUrl: 'wss://example.test', participantToken: 'redacted' })
        },
      },
    )

    expect(response?.status).toBe(200)
    expect(upstreamOrigin).toBe('https://berniesheating.com')
  })

  it('owns /api when configured but refuses unknown paths and wrong methods', async () => {
    const fetch = async () => new Response('unexpected')
    const unknown = await handlePublicApiProxy(
      request('/api/admin'),
      new URL('https://berniesheating.com/api/admin'),
      { baseUrl: proxyUrl, fetch },
    )
    const wrongMethod = await handlePublicApiProxy(
      request('/api/weather', { method: 'POST' }),
      new URL('https://berniesheating.com/api/weather'),
      { baseUrl: proxyUrl, fetch },
    )

    expect(unknown?.status).toBe(404)
    expect(wrongMethod?.status).toBe(405)
  })

  it('does not own /api when no upstream is configured', async () => {
    const response = await handlePublicApiProxy(
      request('/api/weather'),
      new URL('https://berniesheating.com/api/weather'),
      { baseUrl: null },
    )
    expect(response).toBeNull()
  })

  it('rejects oversized bodies without contacting the upstream', async () => {
    let called = false
    const response = await handlePublicApiProxy(
      request('/api/contact', {
        method: 'POST',
        body: 'x'.repeat(65 * 1024),
      }),
      new URL('https://berniesheating.com/api/contact'),
      {
        baseUrl: proxyUrl,
        fetch: async () => {
          called = true
          return new Response()
        },
      },
    )

    expect(response?.status).toBe(413)
    expect(called).toBe(false)
  })

  it('returns a generic gateway error when the private service is unavailable', async () => {
    const response = await handlePublicApiProxy(
      request('/api/weather'),
      new URL('https://berniesheating.com/api/weather'),
      {
        baseUrl: proxyUrl,
        fetch: async () => { throw new Error('private DNS detail') },
      },
    )

    expect(response?.status).toBe(502)
    expect(await response?.json()).toEqual({ error: 'API service is unavailable.' })
  })
})
