/**
 * Visitor-session cookie helpers + an in-memory session validation cache.
 *
 * Cookie helpers mirror `server/handlers/cms/session.ts` but scope the
 * cookie to `Path=/` (visitor auth gates public-site routes, not the admin
 * SPA) and use the visitor cookie name. The `Secure` flag follows the same
 * rule: set when the configured public origin is HTTPS OR the request URL
 * is https — the former covers TLS-terminating edges that hand the
 * container plain HTTP.
 *
 * The validation cache (D5) fronts `findActiveVisitorSessionByHash` with a
 * short-TTL `Map` so a visitor navigating between protected pages does not
 * pay a DB round-trip per request. A hit whose cached session is past its
 * `expires_at` is treated as a miss; a hit that is still live optionally
 * fires a debounced `touchVisitorSession` (no `await`) so `last_seen_at`
 * stays fresh without write amplification.
 */
import type { DbClient } from '../db/client'
import { hashSessionToken } from '../auth/tokens'
import { publicOriginIsHttps } from '../auth/security'
import {
  VISITOR_SESSION_COOKIE_NAME,
  type VisitorSession,
} from './types'
import { findActiveVisitorSessionByHash, touchVisitorSession } from './repositories'

/** True when the inbound request was made over HTTPS (configured origin wins). */
function requestIsHttps(req: Request): boolean {
  if (publicOriginIsHttps()) return true
  return req.url.startsWith('https://')
}

function visitorCookieAttributes(secure: boolean): string {
  // Path=/       — visitor auth gates public-site routes, not just /admin.
  // HttpOnly     — JS in the browser cannot read the cookie (XSS mitigation).
  // SameSite=Lax — cross-origin POST/PUT/DELETE don't carry the cookie (CSRF).
  // Secure       — browser only sends the cookie over HTTPS (set when applicable).
  const base = 'Path=/; HttpOnly; SameSite=Lax'
  return secure ? `${base}; Secure` : base
}

export function visitorSessionCookie(req: Request, token: string, expiresAt: Date): string {
  const attrs = visitorCookieAttributes(requestIsHttps(req))
  return `${VISITOR_SESSION_COOKIE_NAME}=${token}; ${attrs}; Expires=${expiresAt.toUTCString()}`
}

export function clearVisitorSessionCookie(req: Request): string {
  const attrs = visitorCookieAttributes(requestIsHttps(req))
  return `${VISITOR_SESSION_COOKIE_NAME}=; ${attrs}; Max-Age=0`
}

/** Parse a `Cookie` header into a flat map. Returns `{}` when absent. */
function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/**
 * Read the visitor session cookie off the request and return its hash, or
 * `null` when no cookie is present. The hash (not the raw token) is the
 * `visitor_sessions.id_hash` key, so it is safe to log / use as a cache key.
 */
export async function getVisitorSessionIdHash(req: Request): Promise<string | null> {
  const cookies = parseCookies(req.headers.get('cookie'))
  const token = cookies[VISITOR_SESSION_COOKIE_NAME]
  if (!token) return null
  return hashSessionToken(token)
}

// ---------------------------------------------------------------------------
// In-memory session cache (D5)
// ---------------------------------------------------------------------------

const SESSION_CACHE_TTL_MS = 5 * 60 * 1000
const SESSION_TOUCH_DEBOUNCE_MS = 30 * 1000

interface CachedEntry {
  session: VisitorSession
  /** Wall-clock time the entry was populated — drives the TTL eviction. */
  cachedAt: number
}

const sessionCache = new Map<string, CachedEntry>()

/** Drop the cached entry for `idHash` — call on logout / revoke. */
export function invalidateVisitorSessionCache(idHash: string): void {
  sessionCache.delete(idHash)
}

/**
 * Resolve the request to a live visitor session, or `null` when there is no
 * cookie / the session was revoked / the session has expired.
 *
 * Cache flow:
 *   1. No cookie → `null`.
 *   2. Cache hit AND the session is still within its `expires_at` → return
 *      the cached session. Side-effect: if `lastSeenAt` is older than the
 *      debounce window, fire-and-forget `touchVisitorSession` (no `await`).
 *   3. Cache miss (or stale) → `findActiveVisitorSessionByHash`; `null` →
 *      return `null`; otherwise cache + return.
 *
 * The cache is keyed by the token hash and bounded by a 5-minute TTL — a
 * revoked session therefore lingers for at most 5 minutes after logout on a
 * given worker unless `invalidateVisitorSessionCache` is called. The logout
 * handler calls it, so the common path clears immediately.
 */
export async function validateVisitorSession(
  db: DbClient,
  req: Request,
): Promise<VisitorSession | null> {
  const idHash = await getVisitorSessionIdHash(req)
  if (!idHash) return null

  const now = Date.now()
  const cached = sessionCache.get(idHash)
  if (cached) {
    const expiredByTtl = now - cached.cachedAt > SESSION_CACHE_TTL_MS
    const expiredByExpiry = Date.parse(cached.session.expiresAt) <= now
    if (!expiredByTtl && !expiredByExpiry) {
      // Debounced last-seen touch — never awaited, never blocks the response.
      if (now - Date.parse(cached.session.lastSeenAt) > SESSION_TOUCH_DEBOUNCE_MS) {
        void touchVisitorSession(db, idHash, new Date(now).toISOString())
        // Optimistically advance the cached lastSeenAt so we don't fire a
        // touch on every subsequent in-window request.
        cached.session = { ...cached.session, lastSeenAt: new Date(now).toISOString() }
      }
      return cached.session
    }
    sessionCache.delete(idHash)
  }

  const session = await findActiveVisitorSessionByHash(db, idHash)
  if (!session) return null
  sessionCache.set(idHash, { session, cachedAt: now })
  return session
}
