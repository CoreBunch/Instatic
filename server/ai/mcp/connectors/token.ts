/** Opaque MCP credentials. Only one-way SHA-256 hashes are persisted. */
const TOKEN_BYTES = 32

export function generatePersonalAccessToken(): string {
  return generateSecret('imcp_pat_')
}

export function generateOAuthAuthorizationCode(): string {
  return generateSecret('imcp_ac_')
}

export function generateOAuthAccessToken(): string {
  return generateSecret('imcp_at_')
}

export function generateOAuthRefreshToken(): string {
  return generateSecret('imcp_rt_')
}

export async function hashMcpSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

export async function pkceChallengeForVerifier(verifier: string): Promise<string> {
  return hashMcpSecret(verifier)
}

function generateSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))
  return `${prefix}${toBase64Url(bytes)}`
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
