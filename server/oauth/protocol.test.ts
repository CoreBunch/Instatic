import { describe, expect, it } from 'bun:test'
import {
  hasDuplicateParameters,
  isValidPkceChallenge,
  isValidPkceVerifier,
  oauthRedirect,
  parseAllowedRedirectUri,
  redirectUriRegistered,
  scopeIsSubset,
} from './protocol'
import { generateOpaqueToken, hashOpaqueToken, pkceChallengeForVerifier } from './secrets'

describe('redirect URIs a client may register', () => {
  it.each([
    'https://app.example.com/callback',
    'http://127.0.0.1:47821/callback',
    'http://[::1]:47821/callback',
    'http://localhost:3000/callback',
  ])('accepts %s', (uri) => {
    expect(parseAllowedRedirectUri(uri)).not.toBeNull()
  })

  it.each([
    'http://app.example.com/callback',
    'http://127.example.com/callback',
    'http://127.0.0.1.example.com/callback',
    'https://user:pass@app.example.com/callback',
    'https://app.example.com/callback#fragment',
    'myapp://callback',
    'not a url',
  ])('refuses %s', (uri) => {
    expect(parseAllowedRedirectUri(uri)).toBeNull()
  })
})

describe('matching a requested redirect URI to the registered ones', () => {
  it('matches an identical URI', () => {
    expect(redirectUriRegistered(['https://app.example.com/cb'], 'https://app.example.com/cb')).toBe(true)
  })

  it('ignores the port on a loopback IP literal', () => {
    expect(redirectUriRegistered(['http://127.0.0.1/callback'], 'http://127.0.0.1:51234/callback')).toBe(true)
    expect(redirectUriRegistered(['http://127.0.0.1:47821/callback'], 'http://127.0.0.1:9/callback')).toBe(true)
    expect(redirectUriRegistered(['http://[::1]:47821/callback'], 'http://[::1]:60000/callback')).toBe(true)
  })

  it('still compares the host, the path and the query on loopback', () => {
    const registered = ['http://127.0.0.1:47821/callback']
    expect(redirectUriRegistered(registered, 'http://127.0.0.1:47821/other')).toBe(false)
    expect(redirectUriRegistered(registered, 'http://127.0.0.1:47821/callback?x=1')).toBe(false)
    expect(redirectUriRegistered(registered, 'http://[::1]:47821/callback')).toBe(false)
    expect(redirectUriRegistered(registered, 'http://127.0.0.2:47821/callback')).toBe(false)
  })

  it('gives localhost and https no port exception', () => {
    expect(redirectUriRegistered(['http://localhost:3000/cb'], 'http://localhost:3001/cb')).toBe(false)
    expect(redirectUriRegistered(['https://app.example.com/cb'], 'https://app.example.com:8443/cb')).toBe(false)
  })

  it('does not let a loopback name that only starts like an address through', () => {
    expect(redirectUriRegistered(['http://127.0.0.1/cb'], 'http://127.0.0.1.evil.example:80/cb')).toBe(false)
  })
})

describe('PKCE', () => {
  it('accepts a 43-character S256 challenge and a 43 to 128 character verifier', async () => {
    const verifier = 'a'.repeat(43)
    expect(isValidPkceVerifier(verifier)).toBe(true)
    expect(isValidPkceVerifier('a'.repeat(42))).toBe(false)
    expect(isValidPkceVerifier('a'.repeat(129))).toBe(false)
    const challenge = await pkceChallengeForVerifier(verifier)
    expect(isValidPkceChallenge(challenge)).toBe(true)
    expect(isValidPkceChallenge(`${challenge}=`)).toBe(false)
  })
})

describe('opaque tokens', () => {
  it('carry their prefix and hash to a url-safe value that is not the token', async () => {
    const token = generateOpaqueToken('test_at_')
    expect(token).toMatch(/^test_at_[A-Za-z0-9_-]{43}$/)
    expect(generateOpaqueToken('test_at_')).not.toBe(token)
    const hash = await hashOpaqueToken(token)
    expect(hash).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(hash).not.toContain(token)
    expect(await hashOpaqueToken(token)).toBe(hash)
  })
})

describe('request helpers', () => {
  it('adds the authorization response to the redirect and keeps its own query', () => {
    const url = new URL(oauthRedirect('http://127.0.0.1:1/cb?keep=1', { code: 'c', state: undefined }))
    expect(url.searchParams.get('keep')).toBe('1')
    expect(url.searchParams.get('code')).toBe('c')
    expect(url.searchParams.has('state')).toBe(false)
  })

  it('knows a narrower scope from a wider one', () => {
    expect(scopeIsSubset('a', 'a b')).toBe(true)
    expect(scopeIsSubset('a c', 'a b')).toBe(false)
  })

  it('spots a parameter sent twice', () => {
    expect(hasDuplicateParameters(new URLSearchParams('a=1&b=2'))).toBe(false)
    expect(hasDuplicateParameters(new URLSearchParams('a=1&a=2'))).toBe(true)
  })
})
