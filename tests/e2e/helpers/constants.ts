/**
 * Shared constants for the automated Playwright E2E suite.
 *
 * The Playwright `webServer` (`scripts/e2e-dev.ts`) resets the disposable
 * `.tmp/e2e-*` database once per run and then serves a single shared stack:
 * one admin origin, one public origin, one SQLite database. Every spec runs
 * serially against that shared state (`workers: 1`), so these constants are the
 * single source of truth for the suite identities and origins.
 */

/** First-run owner created by the `setup` project and reused by ordinary specs. */
export const OWNER = {
  email: 'owner.e2e@example.com',
  password: 'qwerty123456',
  siteName: 'Automated E2E Site',
} as const

/** Public (visitor-facing) origin. Different port → always a fresh context. */
export const PUBLIC_BASE_URL =
  process.env.E2E_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3002'

/**
 * Saved owner authentication state. The `setup` project writes this after
 * first-run setup; specs that opt in start already logged in as the owner.
 */
export const OWNER_STATE_FILE = '.tmp/e2e-owner-state.json'

/**
 * An empty (logged-out) storage state. Specs that **publish** (which triggers a
 * step-up) or **sign out** must opt into this and `login()` fresh, because both
 * actions rotate the session token server-side — reusing the shared owner state
 * would invalidate it for every later spec. Read-only specs keep the fast shared
 * owner state.
 */
export const ANONYMOUS_STATE = { cookies: [], origins: [] }

/**
 * Dedicated identity for account-global security flows. Password changes, MFA
 * changes, and "sign out everywhere else" revoke other sessions for the target
 * account, so `account.e2e.ts` uses this Admin instead of invalidating the owner
 * session saved in `OWNER_STATE_FILE` for the rest of the suite.
 */
export const ACCOUNT_PERSONA = {
  email: 'account.persona.e2e@example.com',
  password: 'account-persona-pass-12345',
  displayName: 'Account Persona',
  role: 'Admin',
} as const
