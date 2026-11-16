/**
 * The cookies that are credentials: the admin session, the member session,
 * and the member sign-up nonce. Anything that passes a visitor's cookies to
 * code outside the core (plugin route handlers, per-visitor plugin loop
 * sources) removes these first. The host has already decided who the caller
 * is; a session token in plugin hands could be replayed.
 */
import { SESSION_COOKIE_NAME } from './auth/tokens'
import { MEMBER_COOKIE_NAMES, MEMBER_SIGNUP_NONCE_COOKIE } from './members/sessions'

const SESSION_COOKIE_NAMES = new Set<string>([
  SESSION_COOKIE_NAME,
  ...MEMBER_COOKIE_NAMES,
  MEMBER_SIGNUP_NONCE_COOKIE,
])

export function isSessionCookieName(name: string): boolean {
  return SESSION_COOKIE_NAMES.has(name)
}

/** A `Cookie` header with every session cookie removed. */
export function withoutSessionCookies(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !isSessionCookieName(part.split('=')[0].trim()))
    .join('; ')
}
