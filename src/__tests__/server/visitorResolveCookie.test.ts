/**
 * Integration tests for `resolveVisitorFromCookie` — the IDOR-safe identity
 * boundary for the visitor-data framework.
 *
 * This resolver is the SINGLE place where cookie → visitor identity is
 * resolved for the `visitor.current` and `visitor.owned-rows` loop sources.
 * Its security contract (identity comes ONLY from the validated session
 * cookie, never from request input) is locked statically by the architecture
 * gate; these tests pin the RUNTIME behaviour across every branch:
 *
 *   - no cookie map at all                → null
 *   - cookie map without a session cookie → null
 *   - a session cookie that doesn't exist → null
 *   - a revoked / expired session         → null
 *   - a valid session whose user is gone  → null
 *   - a valid session                     → ResolvedVisitor (id/email/role/profile)
 *
 * Uses `createTestDb()` (real in-memory SQLite, all migrations applied) and
 * seeds genuine session rows via the production `createSessionToken` /
 * `hashSessionToken` pipeline — no hand-rolled token maths — so the
 * integration with the cached `validateVisitorSession` is exercised truthfully.
 *
 * Each branch gets its OWN visitor + fresh random token so the process-global
 * session cache can't alias one test's identity with another's.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { resolveVisitorFromCookie } from '../../../server/visitor-auth/visitorData'
import { VISITOR_SESSION_COOKIE_NAME } from '../../../server/visitor-auth/types'
import { invalidateVisitorSessionCache } from '../../../server/visitor-auth/sessions'
import { createSessionToken, hashSessionToken, sessionExpiry } from '../../../server/auth/tokens'

type Db = TestDb['db']

/** Insert a visitor role + user directly (mirrors migration 021 columns). */
async function seedVisitor(db: Db, id: string, email: string, displayName?: string): Promise<void> {
  // The 'member' system role is seeded by migration 021; reuse it.
  await db`
    insert into visitor_users (id, email, email_normalized, password_hash, display_name, role_id, status, profile_fields_json)
    values (${id}, ${email}, ${email}, 'h', ${displayName ?? email.split('@')[0]}, 'member', 'active', ${JSON.stringify({ schoolName: 'Oasis' })})
  `
}

/**
 * Seed a session row directly and return the RAW token to put in a cookie.
 * Inserts directly (rather than via createVisitorSession) so expired/revoked
 * variants can be seeded — createVisitorSession re-reads via
 * findActiveVisitorSessionByHash and would reject an already-inactive row.
 * Uses the production token pipeline so the resolver's hash + DB lookup path
 * is exercised end-to-end. Invalidates the process-global session cache for
 * this idHash so a stale entry from another test can't leak in.
 */
async function seedSession(
  db: Db,
  userId: string,
  overrides: { revoked?: boolean; expiresAt?: Date } = {},
): Promise<string> {
  const token = createSessionToken()
  const idHash = await hashSessionToken(token)
  const expiresAt = overrides.expiresAt ?? sessionExpiry()
  await db`
    insert into visitor_sessions (id_hash, user_id, expires_at, ip_address, user_agent, device_label)
    values (${idHash}, ${userId}, ${expiresAt}, ${null}, ${null}, '')
  `
  if (overrides.revoked) {
    await db`update visitor_sessions set revoked_at = ${new Date().toISOString()} where id_hash = ${idHash}`
  }
  invalidateVisitorSessionCache(idHash)
  return token
}

function cookieFromToken(token: string): Record<string, string> {
  return { [VISITOR_SESSION_COOKIE_NAME]: token }
}

let testDb: TestDb
let db: Db

beforeAll(async () => {
  testDb = await createTestDb()
  db = testDb.db
})

afterAll(async () => {
  await testDb.cleanup()
})

describe('resolveVisitorFromCookie (IDOR identity boundary)', () => {
  it('returns null when no cookie map is supplied', async () => {
    expect(await resolveVisitorFromCookie(db, undefined)).toBeNull()
  })

  it('returns null when the cookie map has no visitor session cookie', async () => {
    expect(await resolveVisitorFromCookie(db, { unrelated_cookie: 'x' })).toBeNull()
  })

  it('returns null for a session cookie whose token matches no session', async () => {
    expect(await resolveVisitorFromCookie(db, cookieFromToken('not-a-real-token'))).toBeNull()
  })

  it('returns null for a REVOKED session', async () => {
    await seedVisitor(db, 'v-revoked', 'revoked@example.com')
    const token = await seedSession(db, 'v-revoked', { revoked: true })
    expect(await resolveVisitorFromCookie(db, cookieFromToken(token))).toBeNull()
  })

  it('returns null for an EXPIRED session', async () => {
    await seedVisitor(db, 'v-expired', 'expired@example.com')
    const token = await seedSession(db, 'v-expired', { expiresAt: new Date(Date.now() - 60_000) })
    expect(await resolveVisitorFromCookie(db, cookieFromToken(token))).toBeNull()
  })

  it('returns null when the session is valid but the visitor record is gone', async () => {
    await seedVisitor(db, 'v-gone', 'gone@example.com')
    const token = await seedSession(db, 'v-gone')
    await db`update visitor_users set deleted_at = ${new Date().toISOString()} where id = ${'v-gone'}`
    expect(await resolveVisitorFromCookie(db, cookieFromToken(token))).toBeNull()
  })

  it('resolves the full ResolvedVisitor for a valid session', async () => {
    await seedVisitor(db, 'v-resolve', 'resolve@example.com', 'Resolve Me')
    const token = await seedSession(db, 'v-resolve')
    const resolved = await resolveVisitorFromCookie(db, cookieFromToken(token))

    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe('v-resolve')
    expect(resolved!.email).toBe('resolve@example.com')
    expect(resolved!.displayName).toBe('Resolve Me')
    expect(resolved!.roleId).toBe('member')
    expect(resolved!.roleName).toBe('member') // resolved via findVisitorRoleById
    // Custom profile field values are carried through.
    expect(resolved!.profileFields).toMatchObject({ schoolName: 'Oasis' })
  })

  it('never inspects cookie values other than the session cookie', async () => {
    await seedVisitor(db, 'v-forged', 'forged@example.com')
    const token = await seedSession(db, 'v-forged')
    // A cookie map carrying forged visitor/user ids must not influence the
    // result — identity comes only from the validated session token.
    const resolved = await resolveVisitorFromCookie(db, {
      ...cookieFromToken(token),
      visitorId: 'attacker',
      userId: 'attacker',
      id: 'attacker',
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe('v-forged') // not 'attacker'
  })
})
