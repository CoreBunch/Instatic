/**
 * The one email validity check, shared by every surface that accepts an
 * email address: CMS setup, the users admin API (via the users repository),
 * the pre-auth setup form, and the published forms engine. Pragmatic shape check (something@something.tld, no
 * whitespace) — not RFC 5321 trivia; the server never sends verification
 * mail, so the goal is catching typos and non-emails, not litigating quoted
 * local parts.
 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
