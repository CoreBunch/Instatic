/**
 * One-time sign-in links: how a manager opens a site's admin without a
 * password.
 *
 * The manager (which already holds the instance's manager token) asks for a
 * link; the server answers with a short-lived, single-use token. Opening the
 * link in a browser signs that browser in as the site owner and redirects to
 * the admin. No password is stored anywhere, and the link keeps working when
 * someone changes theirs.
 *
 * Tokens live in memory only, as hashes: a restart forgets them, and reading
 * this process's memory would not yield a usable link.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { DbClient } from '../db/client'

/** Long enough to open a browser tab, short enough to be useless if leaked. */
export const LOGIN_LINK_TTL_MS = 60_000
/** Outstanding links at once. Asking for more drops the oldest. */
const MAX_OUTSTANDING = 20

interface Pending {
  userId: string
  expiresAt: number
}

const pending = new Map<string, Pending>()

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function prune(now: number): void {
  for (const [hash, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(hash)
  }
  while (pending.size >= MAX_OUTSTANDING) {
    const oldest = pending.keys().next()
    if (oldest.done) break
    pending.delete(oldest.value)
  }
}

/** Mint a link token for `userId`. The caller builds the URL around it. */
export function createLoginLink(userId: string, now = Date.now()): { token: string; expiresAt: Date } {
  prune(now)
  const token = randomBytes(32).toString('base64url')
  const expiresAt = now + LOGIN_LINK_TTL_MS
  pending.set(hashToken(token), { userId, expiresAt })
  return { token, expiresAt: new Date(expiresAt) }
}

/** Spend a token. Returns the user it signs in, or null; a token works once. */
export function redeemLoginLink(token: string, now = Date.now()): string | null {
  const hash = hashToken(token)
  const entry = pending.get(hash)
  if (!entry) return null
  pending.delete(hash)
  return entry.expiresAt > now ? entry.userId : null
}

/** The active owner a manager link signs in as: the earliest one created. */
export async function findOwnerUserId(db: DbClient): Promise<string | null> {
  const { rows } = await db<{ id: string }>`
    select id from users
    where role_id = ${'owner'} and status = ${'active'} and deleted_at is null
    order by created_at asc
    limit 1
  `
  return rows[0]?.id ?? null
}
