import { afterEach, describe, expect, it } from 'bun:test'
import { configurePublicOrigins, resetPublicOrigins } from '../../../auth/security'
import {
  mcpIssuer,
  mcpOAuthEndpoints,
  mcpProtectedResourceMetadataUrl,
  mcpResource,
} from './protocol'

/**
 * happy-dom (loaded by the test setup) strips the Fetch-spec forbidden `Host`
 * header from the Request constructor's `headers` init, so it is set on the
 * Headers object afterwards, the same way a real Bun.serve request carries it.
 */
function requestAt(url: string, host?: string): Request {
  const req = new Request(url)
  if (host) req.headers.set('host', host)
  return req
}

afterEach(() => {
  resetPublicOrigins()
})

describe('mcpIssuer', () => {
  it('uses the configured public origin regardless of the inbound Host', () => {
    configurePublicOrigins(['https://cms.example.com'])
    const req = requestAt('https://attacker.example/_instatic/mcp', 'attacker.example')
    expect(mcpIssuer(req)).toBe('https://cms.example.com')
    expect(mcpResource(req)).toBe('https://cms.example.com/_instatic/mcp')
    expect(mcpProtectedResourceMetadataUrl(req)).toBe(
      'https://cms.example.com/.well-known/oauth-protected-resource',
    )
    const endpoints = mcpOAuthEndpoints(req)
    expect(endpoints).not.toBeNull()
    for (const value of Object.values(endpoints!)) {
      expect(new URL(value).origin).toBe('https://cms.example.com')
    }
  })

  it.each([
    ['http://localhost:3001/_instatic/mcp', 'http://localhost:3001'],
    ['http://127.0.0.1:3001/_instatic/mcp', 'http://127.0.0.1:3001'],
    ['http://[::1]:3001/_instatic/mcp', 'http://[::1]:3001'],
  ])('falls back to the loopback request origin without a configured origin (%s)', (url, origin) => {
    const req = requestAt(url)
    expect(mcpIssuer(req)).toBe(origin)
    expect(mcpResource(req)).toBe(`${origin}/_instatic/mcp`)
    expect(mcpOAuthEndpoints(req)?.tokenEndpoint).toBe(`${origin}/_instatic/oauth/token`)
  })

  it('has no issuer for a non-loopback request without a configured origin', () => {
    const req = requestAt('http://attacker.example:18020/_instatic/mcp', 'attacker.example:18020')
    expect(mcpIssuer(req)).toBeNull()
    expect(mcpResource(req)).toBeNull()
    expect(mcpProtectedResourceMetadataUrl(req)).toBeNull()
    expect(mcpOAuthEndpoints(req)).toBeNull()
  })

  it('does not treat a loopback-looking Host on a non-loopback request URL as local', () => {
    const req = requestAt('http://attacker.example/_instatic/mcp', 'localhost:3001')
    expect(mcpIssuer(req)).toBeNull()
  })
})
