/**
 * Cookies that are credentials never reach code outside the core.
 *
 * Every cookie Instatic sets is one: the admin session, the member session,
 * the member sign-up nonce, the branch-preview token. They all carry the
 * `instatic_` name (with or without the `__Host-` prefix), so the rule is by
 * name prefix rather than a list a new cookie could be forgotten from.
 * Plugin route handlers and per-visitor plugin loop sources get the
 * visitor's other cookies; the host has already decided who the caller is.
 */
const OWN_COOKIE = /^(__Host-|__Secure-)?instatic_/i

export function isSessionCookieName(name: string): boolean {
  return OWN_COOKIE.test(name)
}

/** A `Cookie` header with every Instatic cookie removed. */
export function withoutSessionCookies(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !isSessionCookieName(part.split('=')[0].trim()))
    .join('; ')
}
