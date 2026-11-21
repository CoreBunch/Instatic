/**
 * Opaque credentials: authorization codes, access tokens, refresh tokens and
 * personal access tokens. A value is random bytes behind a prefix that names
 * what it is; only its one-way SHA-256 hash is ever stored.
 */
const TOKEN_BYTES = 32

export function generateOpaqueToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return `${prefix}${toBase64Url(bytes)}`
}

export async function hashOpaqueToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

/** The S256 challenge a PKCE verifier answers to. */
export async function pkceChallengeForVerifier(verifier: string): Promise<string> {
  return hashOpaqueToken(verifier)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
