/**
 * A device key as an app would keep one, for tests: makes DPoP proofs
 * (RFC 9449) the way a client does, so the server side is exercised with
 * real signatures.
 */
import { jwkThumbprint } from '../../../server/oauth/dpop'

function base64Url(value: string | ArrayBuffer): string {
  return Buffer.from(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)).toString('base64url')
}

export interface DeviceKey {
  thumbprint: string
  /** A proof for one request. `overrides` replaces claims or header fields, to build a bad one. */
  proof(
    method: string,
    url: string,
    overrides?: { claims?: Record<string, unknown>; header?: Record<string, unknown> },
  ): Promise<string>
}

export async function createDeviceKey(alg: 'EdDSA' | 'ES256' = 'EdDSA'): Promise<DeviceKey> {
  const pair = alg === 'EdDSA'
    ? await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    : await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const jwk = alg === 'EdDSA'
    ? { kty: 'OKP' as const, crv: 'Ed25519' as const, x: exported.x! }
    : { kty: 'EC' as const, crv: 'P-256' as const, x: exported.x!, y: exported.y! }
  return {
    thumbprint: await jwkThumbprint(jwk),
    async proof(method, url, overrides = {}) {
      const header = { typ: 'dpop+jwt', alg, jwk, ...overrides.header }
      const claims = {
        jti: crypto.randomUUID(), htm: method, htu: url, iat: Math.floor(Date.now() / 1000), ...overrides.claims,
      }
      const signed = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
      const signature = await crypto.subtle.sign(
        alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(signed),
      )
      return `${signed}.${base64Url(signature)}`
    },
  }
}
