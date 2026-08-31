import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'instatic_admin_session'

/**
 * Length-independent, content-constant-time string comparison. The single
 * copy for every secret comparison in the server (TOTP codes, recovery-code
 * hashes, form challenge + page tokens) — `timingSafeEqual` throws on unequal
 * lengths, so the length check must come first and is deliberately NOT
 * constant-time (secret length is not itself a secret here).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
const SESSION_ABSOLUTE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 90

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash)
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function hashSessionToken(token: string): Promise<string> {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionExpiry(now = Date.now()): Date {
  return new Date(now + SESSION_ABSOLUTE_TIMEOUT_MS)
}
