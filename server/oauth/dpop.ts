/**
 * Proof of possession for public clients (DPoP, RFC 9449).
 *
 * A native app cannot keep a client secret, so a refresh token it holds is
 * only as safe as the file it sits in. With DPoP the app also keeps a key
 * pair (in the OS keychain) and signs a short proof for every request to the
 * token endpoint. A grant bound to that key's thumbprint can only be
 * refreshed by a caller who can sign with it: a copied refresh token alone
 * does nothing.
 *
 * This file verifies a proof and returns the key's thumbprint (RFC 7638).
 * What the thumbprint must match is the caller's business.
 */
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'

/** What a proof may be signed with. ES256 is what hardware keystores offer; EdDSA is the simplest in software. */
export const DPOP_ALGORITHMS = ['EdDSA', 'ES256'] as const

const PROOF_MAX_LENGTH = 4096
/** How far a proof's `iat` may be from this server's clock, either way. */
const CLOCK_WINDOW_MS = 5 * 60 * 1000
const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** A 32-byte value in base64url: an Ed25519 public key or one P-256 coordinate. */
const KeyCoordinate = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })

const OkpKeySchema = Type.Object({
  kty: Type.Literal('OKP'),
  crv: Type.Literal('Ed25519'),
  x: KeyCoordinate,
}, { additionalProperties: true })

const EcKeySchema = Type.Object({
  kty: Type.Literal('EC'),
  crv: Type.Literal('P-256'),
  x: KeyCoordinate,
  y: KeyCoordinate,
}, { additionalProperties: true })

const ProofHeaderSchema = Type.Object({
  typ: Type.Literal('dpop+jwt'),
  alg: Type.Union(DPOP_ALGORITHMS.map((alg) => Type.Literal(alg))),
  jwk: Type.Union([OkpKeySchema, EcKeySchema]),
}, { additionalProperties: true })

const ProofClaimsSchema = Type.Object({
  jti: Type.String({ minLength: 8, maxLength: 128 }),
  htm: Type.String({ minLength: 1, maxLength: 16 }),
  htu: Type.String({ minLength: 1, maxLength: 2048 }),
  iat: Type.Number(),
}, { additionalProperties: true })

export function isKeyThumbprint(value: string): boolean {
  return THUMBPRINT_PATTERN.test(value)
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, 'base64url')
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

function parseJsonPart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch (_err) {
    // Not JSON: the proof is malformed, which the caller reports as such.
    return null
  }
}

/**
 * The Ed25519 points of small order (1, 2, 4 and 8), as 32-byte encodings
 * with the sign bit cleared. The last two are the same points as the first
 * two written with a `y` above the field prime, which runtimes also accept.
 *
 * A "key" at one of these points has no private half, yet a signature anyone
 * can write down (R the identity, S zero) verifies under it for some or all
 * messages, because verification here is not strict. Such a key proves
 * nothing, so a proof naming one is refused.
 */
const ED25519_SMALL_ORDER_POINTS = new Set([
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
])

function isSmallOrderEd25519Key(x: string): boolean {
  const point = Buffer.from(x, 'base64url')
  // The top bit is the sign of the other coordinate: each point above has a
  // twin that differs only there.
  point[31] = point[31]! & 0x7f
  return ED25519_SMALL_ORDER_POINTS.has(point.toString('hex'))
}

type PublicJwk =
  | { kty: 'OKP'; crv: 'Ed25519'; x: string }
  | { kty: 'EC'; crv: 'P-256'; x: string; y: string }

/** RFC 7638: SHA-256 over the key's required members, in lexicographic order. */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  const canonical = jwk.kty === 'OKP'
    ? `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`
    : `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Buffer.from(digest).toString('base64url')
}

async function verifySignature(alg: string, jwk: PublicJwk, signed: string, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const data = new TextEncoder().encode(signed)
  try {
    if (alg === 'EdDSA' && jwk.kty === 'OKP') {
      const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, false, ['verify'])
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data)
    }
    if (alg === 'ES256' && jwk.kty === 'EC') {
      const key = await crypto.subtle.importKey(
        'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
      )
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data)
    }
  } catch (_err) {
    // A key the runtime will not import is not a key we can trust a proof from.
    return false
  }
  // The algorithm and the key type disagree.
  return false
}

// Proofs already seen, until they fall out of the clock window. One process
// serves a site, so memory is enough; the map is trimmed as it is used.
const seenProofs = new Map<string, number>()

function rememberProof(key: string, now: number): boolean {
  for (const [seen, expires] of seenProofs) {
    if (expires > now) break
    seenProofs.delete(seen)
  }
  if (seenProofs.has(key)) return false
  seenProofs.set(key, now + 2 * CLOCK_WINDOW_MS)
  return true
}

/** Test seam: forget every proof seen. */
export function resetDpopReplayCache(): void {
  seenProofs.clear()
}

function sameEndpoint(htu: string, expected: string): boolean {
  try {
    const claimed = new URL(htu)
    const wanted = new URL(expected)
    return claimed.origin === wanted.origin && claimed.pathname === wanted.pathname
  } catch (_err) {
    // Not a URL: it names no endpoint of ours.
    return false
  }
}

/**
 * Verify the `DPoP` header of a request to `method` `url`. Returns the
 * thumbprint of the key that signed it, or null when the proof is missing a
 * part, signed with the wrong key, meant for another request, too old, or
 * seen before.
 */
export async function verifyDpopProof(
  proof: string,
  expected: { method: string; url: string },
  now: Date = new Date(),
): Promise<string | null> {
  if (proof.length > PROOF_MAX_LENGTH) return null
  const parts = proof.split('.')
  if (parts.length !== 3 || parts.some((part) => part === '')) return null
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string]

  const header = safeParseValue(ProofHeaderSchema, parseJsonPart(headerPart))
  const claims = safeParseValue(ProofClaimsSchema, parseJsonPart(claimsPart))
  if (!header.ok || !claims.ok) return null
  // A proof carries the public key only. One that includes the private half
  // was built by something that should not be trusted with either.
  if ('d' in header.value.jwk) return null
  // One key, one thumbprint: a coordinate written with spare bits set decodes
  // to the same key but would hash to a different name for it.
  const coordinates = header.value.jwk.kty === 'OKP' ? [header.value.jwk.x] : [header.value.jwk.x, header.value.jwk.y]
  if (coordinates.some((value) => Buffer.from(value, 'base64url').toString('base64url') !== value)) return null
  if (header.value.jwk.kty === 'OKP' && isSmallOrderEd25519Key(header.value.jwk.x)) return null

  const jwk: PublicJwk = header.value.jwk.kty === 'OKP'
    ? { kty: 'OKP', crv: 'Ed25519', x: header.value.jwk.x }
    : { kty: 'EC', crv: 'P-256', x: header.value.jwk.x, y: header.value.jwk.y }
  if (!(await verifySignature(header.value.alg, jwk, `${headerPart}.${claimsPart}`, fromBase64Url(signaturePart)))) {
    return null
  }

  if (claims.value.htm !== expected.method || !sameEndpoint(claims.value.htu, expected.url)) return null
  if (Math.abs(claims.value.iat * 1000 - now.getTime()) > CLOCK_WINDOW_MS) return null

  const thumbprint = await jwkThumbprint(jwk)
  if (!rememberProof(`${thumbprint}:${claims.value.jti}`, now.getTime())) return null
  return thumbprint
}
