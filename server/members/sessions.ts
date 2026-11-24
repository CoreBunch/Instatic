/**
 * Member sessions: the cookie, and the `member_sessions` table behind it.
 *
 * The cookie carries a 32-byte random token; the table stores only its
 * SHA-256. Every lookup is a database read — there is no in-memory session
 * cache, so a revoked session stops working on the very next request.
 *
 * Lifetimes are fixed: 90 days absolute, 30 days idle. Both are enforced in
 * the lookup query together with "not revoked" and "member is active".
 */
import type { DbClient } from '../db/client'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { createSessionToken, hashSessionToken } from '../auth/tokens'
import { publicOriginIsHttps } from '../auth/security'
import { findMemberById, type MemberRecord, type MemberEventContext } from './repository'

const ABSOLUTE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000
const IDLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
/** `last_seen_at` is rewritten at most this often per session. */
const TOUCH_INTERVAL_MS = 60 * 1000

/**
 * On https the cookie uses the `__Host-` prefix: the browser only accepts it
 * with `Secure`, `Path=/` and no `Domain`, so a sibling subdomain or a
 * plain-http page cannot plant or overwrite it. Loopback http development
 * cannot set a `__Host-` cookie in every browser, so it gets a plain name.
 */
const SECURE_COOKIE_NAME = '__Host-instatic_member'
const PLAIN_COOKIE_NAME = 'instatic_member'

/**
 * Short-lived cookie naming the browser that submitted a sign-up, so a
 * confirmation link only applies its password there (`signUp`). Same naming
 * rule as the session cookie: `__Host-` on https, so a sibling subdomain
 * cannot plant its own marker in a visitor's browser and have its sign-up's
 * password accepted there.
 */
const SECURE_SIGNUP_NONCE_COOKIE = '__Host-instatic_member_signup'
const PLAIN_SIGNUP_NONCE_COOKIE = 'instatic_member_signup'

function signupNonceCookieName(req: Request): string {
  return requestIsSecure(req) ? SECURE_SIGNUP_NONCE_COOKIE : PLAIN_SIGNUP_NONCE_COOKIE
}

export function signupNonceCookie(req: Request, nonce: string): string {
  return `${signupNonceCookieName(req)}=${nonce}; ${cookieAttributes(req)}; Max-Age=86400`
}

export function clearSignupNonceCookie(req: Request): string {
  return `${signupNonceCookieName(req)}=; ${cookieAttributes(req)}; Max-Age=0`
}

/**
 * The sign-up marker from the request, or null. Null too when the cookie
 * appears more than once: two values means someone else set one of them.
 */
export function readSignupNonce(req: Request): string | null {
  return readMarkerCookie(req, signupNonceCookieName(req))
}

/**
 * Short-lived cookie naming the browser an app sent to the site to sign a
 * member in. The member's answer counts only from that browser, so an
 * approval address passed to someone else does nothing in theirs.
 */
const SECURE_APP_REQUEST_COOKIE = '__Host-instatic_member_app'
const PLAIN_APP_REQUEST_COOKIE = 'instatic_member_app'

function appRequestCookieName(req: Request): string {
  return requestIsSecure(req) ? SECURE_APP_REQUEST_COOKIE : PLAIN_APP_REQUEST_COOKIE
}

export function appRequestMarkerCookie(req: Request, marker: string): string {
  return `${appRequestCookieName(req)}=${marker}; ${cookieAttributes(req)}; Max-Age=3600`
}

/** A new marker: 32 hex characters, 122 random bits. The only form a marker is ever read in. */
export function createAppRequestMarker(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

const APP_REQUEST_MARKER = /^[0-9a-f]{32}$/

/**
 * The marker from the request, or null. Null when it is not in the form the
 * server generates, so nothing read here can carry cookie syntax. Null too
 * when the cookie appears more than once: this site always sets it with the
 * same name, path and attributes, so a browser never holds two of its own,
 * and a second one was put there by someone else. Accepting whichever one
 * matches would let a planted marker stand in for the browser's own.
 */
export function readAppRequestMarker(req: Request): string | null {
  const values = cookieValues(req, appRequestCookieName(req))
  return values.length === 1 && APP_REQUEST_MARKER.test(values[0]) ? values[0] : null
}

function readMarkerCookie(req: Request, wanted: string): string | null {
  const values = cookieValues(req, wanted)
  return values.length === 1 && /^[A-Za-z0-9-]{20,60}$/.test(values[0]) ? values[0] : null
}

function cookieValues(req: Request, wanted: string): string[] {
  const values: string[] = []
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === wanted) values.push(part.slice(eq + 1).trim())
  }
  return values
}

function requestIsSecure(req: Request): boolean {
  return publicOriginIsHttps() || req.url.startsWith('https://')
}

function cookieName(req: Request): string {
  return requestIsSecure(req) ? SECURE_COOKIE_NAME : PLAIN_COOKIE_NAME
}

function cookieAttributes(req: Request): string {
  const base = 'Path=/; HttpOnly; SameSite=Lax'
  return requestIsSecure(req) ? `${base}; Secure` : base
}

export function memberSessionCookie(req: Request, token: string, expiresAt: string): string {
  return `${cookieName(req)}=${token}; ${cookieAttributes(req)}; Expires=${new Date(expiresAt).toUTCString()}`
}

export function clearMemberSessionCookie(req: Request): string {
  return `${cookieName(req)}=; ${cookieAttributes(req)}; Max-Age=0`
}

/**
 * The raw session token from the request, or null. Only the cookie name that
 * matches the request's security context is read, so a plain-named cookie is
 * never honoured on an https site.
 */
export function readMemberSessionToken(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  const wanted = cookieName(req)
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== wanted) continue
    const value = part.slice(eq + 1).trim()
    // Tokens are base64url; anything else is not one of ours.
    return /^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : null
  }
  return null
}

export interface MemberSession {
  idHash: string
  memberId: string
  createdAt: string
  expiresAt: string
}

/** Create a session and return the raw token for the cookie. */
export async function createMemberSession(
  db: DbClient,
  memberId: string,
  context: MemberEventContext,
  now = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const token = createSessionToken()
  const idHash = await hashSessionToken(token)
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + ABSOLUTE_LIFETIME_MS).toISOString()
  await db`
    insert into member_sessions (id_hash, member_id, ip_address, user_agent, created_at, last_seen_at, expires_at)
    values (
      ${idHash}, ${memberId}, ${context.ipAddress}, ${context.userAgent?.slice(0, 300) ?? null},
      ${createdAt}, ${createdAt}, ${expiresAt}
    )
  `
  return { token, expiresAt }
}

/**
 * Resolve a raw token to a live session, or null. "Live" means: not revoked,
 * inside both lifetimes, and the member is still active.
 */
export async function findMemberSession(
  db: DbClient,
  token: string,
  now = Date.now(),
): Promise<MemberSession | null> {
  const idHash = await hashSessionToken(token)
  const current = new Date(now).toISOString()
  const idleCutoff = new Date(now - IDLE_LIFETIME_MS).toISOString()
  const { rows } = await db<{
    id_hash: string
    member_id: string
    created_at: Date | string
    expires_at: Date | string
    last_seen_at: Date | string
  }>`
    select s.id_hash, s.member_id, s.created_at, s.expires_at, s.last_seen_at
      from member_sessions s
      join members m on m.id = s.member_id
     where s.id_hash = ${idHash}
       and s.revoked_at is null
       and s.expires_at > ${current}
       and s.last_seen_at > ${idleCutoff}
       and m.status = 'active'
       and m.deleted_at is null
     limit 1
  `
  const row = rows[0]
  if (!row) return null
  if (now - new Date(isoDate(row.last_seen_at)).getTime() > TOUCH_INTERVAL_MS) {
    await db`update member_sessions set last_seen_at = ${current} where id_hash = ${idHash}`
  }
  return {
    idHash: row.id_hash,
    memberId: row.member_id,
    createdAt: isoDate(row.created_at),
    expiresAt: isoDate(row.expires_at),
  }
}

export async function revokeMemberSession(db: DbClient, idHash: string): Promise<void> {
  await db`
    update member_sessions set revoked_at = ${nowIso()}
     where id_hash = ${idHash} and revoked_at is null
  `
}

/** Revoke every session of a member, optionally sparing one (the caller's own). */
export async function revokeAllMemberSessions(
  db: DbClient,
  memberId: string,
  exceptIdHash: string | null = null,
): Promise<void> {
  const now = nowIso()
  if (exceptIdHash) {
    await db`
      update member_sessions set revoked_at = ${now}
       where member_id = ${memberId} and revoked_at is null and id_hash <> ${exceptIdHash}
    `
    return
  }
  await db`
    update member_sessions set revoked_at = ${now}
     where member_id = ${memberId} and revoked_at is null
  `
}

export interface MemberSessionSummary {
  createdAt: string
  lastSeenAt: string
  ipAddress: string | null
  userAgent: string | null
}

export async function listMemberSessions(db: DbClient, memberId: string): Promise<MemberSessionSummary[]> {
  const { rows } = await db<{
    created_at: Date | string
    last_seen_at: Date | string
    ip_address: string | null
    user_agent: string | null
  }>`
    select created_at, last_seen_at, ip_address, user_agent from member_sessions
     where member_id = ${memberId} and revoked_at is null and expires_at > ${nowIso()}
     order by last_seen_at desc
  `
  return rows.map((row) => ({
    createdAt: isoDate(row.created_at),
    lastSeenAt: isoDate(row.last_seen_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }))
}

/** A signed-in caller: the member and the session they came in on. */
export interface SignedInMember {
  member: MemberRecord
  session: MemberSession
}

/** The signed-in member behind this request, or null. */
export async function resolveSignedInMember(db: DbClient, req: Request): Promise<SignedInMember | null> {
  const token = readMemberSessionToken(req)
  if (!token) return null
  const session = await findMemberSession(db, token)
  if (!session) return null
  const member = await findMemberById(db, session.memberId)
  return member ? { member, session } : null
}
