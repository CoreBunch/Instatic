import { beforeEach, describe, expect, it } from 'bun:test'
import { createDeviceKey } from '../../src/__tests__/helpers/deviceKey'
import { isKeyThumbprint, jwkThumbprint, resetDpopReplayCache, verifyDpopProof } from './dpop'

const URL_ = 'https://site.example/_instatic/members/oauth/token'
const POST = { method: 'POST', url: URL_ }

describe('DPoP proofs', () => {
  beforeEach(() => resetDpopReplayCache())

  it('accepts a proof from either kind of key and names the key by its thumbprint', async () => {
    for (const alg of ['EdDSA', 'ES256'] as const) {
      const key = await createDeviceKey(alg)
      expect(isKeyThumbprint(key.thumbprint)).toBe(true)
      expect(await verifyDpopProof(await key.proof('POST', URL_), POST)).toBe(key.thumbprint)
    }
  })

  it('computes the RFC 7638 thumbprint', async () => {
    // The Ed25519 example key of RFC 8037, appendix A.3.
    expect(await jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }))
      .toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k')
  })

  it('ignores the query of the address, and refuses another address or method', async () => {
    const key = await createDeviceKey()
    expect(await verifyDpopProof(await key.proof('POST', `${URL_}?x=1`), POST)).toBe(key.thumbprint)
    expect(await verifyDpopProof(await key.proof('POST', 'https://site.example/_instatic/members/oauth/statement'), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('POST', 'https://other.example/_instatic/members/oauth/token'), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('GET', URL_), POST)).toBeNull()
  })

  it('refuses a proof shown twice', async () => {
    const key = await createDeviceKey()
    const proof = await key.proof('POST', URL_)
    expect(await verifyDpopProof(proof, POST)).toBe(key.thumbprint)
    expect(await verifyDpopProof(proof, POST)).toBeNull()
  })

  it('refuses a proof from a clock more than five minutes off, either way', async () => {
    const key = await createDeviceKey()
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyDpopProof(await key.proof('POST', URL_, { claims: { iat: now - 240 } }), POST)).toBe(key.thumbprint)
    expect(await verifyDpopProof(await key.proof('POST', URL_, { claims: { iat: now - 400 } }), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('POST', URL_, { claims: { iat: now + 400 } }), POST)).toBeNull()
  })

  it('refuses a proof whose signature, key or shape is wrong', async () => {
    const key = await createDeviceKey()
    const other = await createDeviceKey()
    const good = await key.proof('POST', URL_)
    const [header, claims, signature] = good.split('.') as [string, string, string]

    // Claims changed after signing.
    const forged = Buffer.from(JSON.stringify({ jti: 'another-id-1', htm: 'POST', htu: URL_, iat: Math.floor(Date.now() / 1000) })).toString('base64url')
    expect(await verifyDpopProof(`${header}.${forged}.${signature}`, POST)).toBeNull()
    // Signed by one key, claiming another.
    const theirs = (await other.proof('POST', URL_)).split('.')[0]!
    expect(await verifyDpopProof(`${theirs}.${claims}.${signature}`, POST)).toBeNull()

    expect(await verifyDpopProof(await key.proof('POST', URL_, { header: { typ: 'JWT' } }), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('POST', URL_, { header: { alg: 'none' } }), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('POST', URL_, { header: { alg: 'ES256' } }), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('POST', URL_, { claims: { jti: undefined } }), POST)).toBeNull()
    for (const junk of ['', 'a.b', 'a.b.c', `${header}..${signature}`, 'x'.repeat(5000)]) {
      expect(await verifyDpopProof(junk, POST)).toBeNull()
    }
  })

  it('refuses a key written in a second way, so one key has one thumbprint', async () => {
    const key = await createDeviceKey()
    const header = JSON.parse(Buffer.from((await key.proof('POST', URL_)).split('.')[0]!, 'base64url').toString()) as { jwk: { x: string } }
    // The last character of 43 carries two spare bits; setting them decodes to the same bytes.
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const twin = header.jwk.x.slice(0, -1) + last[last.indexOf(header.jwk.x.slice(-1)) + 1]
    expect(Buffer.from(twin, 'base64url').equals(Buffer.from(header.jwk.x, 'base64url'))).toBe(true)
    expect(await verifyDpopProof(await key.proof('POST', URL_, { header: { jwk: { ...header.jwk, x: twin } } }), POST)).toBeNull()
    expect(await verifyDpopProof(await key.proof('POST', URL_, { header: { jwk: { ...header.jwk, x: header.jwk.x.slice(0, 20) } } }), POST)).toBeNull()
  })

  it('refuses a proof that carries the private key', async () => {
    const key = await createDeviceKey()
    const header = JSON.parse(Buffer.from((await key.proof('POST', URL_)).split('.')[0]!, 'base64url').toString()) as { jwk: object }
    expect(await verifyDpopProof(await key.proof('POST', URL_, { header: { jwk: { ...header.jwk, d: 'AAAA' } } }), POST)).toBeNull()
  })
})
