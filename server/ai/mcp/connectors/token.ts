/**
 * Connector secrets. The plaintext is shown to the operator exactly once at
 * creation; only its SHA-256 hash is persisted, so a database read can never
 * yield a usable token. Auth (`../auth.ts`) hashes the presented bearer token
 * and looks it up by hash.
 *
 * Uses Web Crypto (`crypto.getRandomValues` / `crypto.subtle`) — available in
 * Bun without imports — so there is no Node `crypto` dependency.
 */
const TOKEN_BYTES = 32 // 32 random bytes → 43 base64url chars

export function generateConnectorToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return `imcp_${toBase64Url(bytes)}`
}

export async function hashConnectorToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
