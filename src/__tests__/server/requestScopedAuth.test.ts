/**
 * Request-scoped auth context — regression tests for the three findings the
 * `RequestContext` refactor resolved:
 *
 *  1. WRITE-ON-EVERY-READ — `findUserBySessionHash` used to fire an
 *     unconditional `update sessions set last_seen_at` on every authenticated
 *     request. It is now debounced (at most one write per session per window).
 *  2. DOUBLE SESSION LOOKUP — a step-up-gated write used to resolve the session
 *     twice (`requireCapability` THEN `requireStepUp` → two
 *     `findUserBySessionHash` calls). `requireStepUp` now takes the
 *     already-resolved `AuthUser`, so the session is fetched exactly once.
 *
 * Both are asserted by wrapping the test DB in a thin counter that tallies the
 * `from sessions … join users` hydrating SELECT and the `update sessions …
 * last_seen_at` write — covering both the tagged-template and `db.unsafe`
 * code paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { findUserBySessionHash } from '../../../server/auth/sessions'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import { loginPerIpRateLimit, loginRateLimit, mfaRateLimit } from '../../../server/auth/rateLimit'
import { stampSocketIp } from '../../../server/auth/security'
import { createTestDb } from '../helpers/createTestDb'

const PASSWORD = 'long-enough-password'
const EMAIL = 'owner@example.com'
const IP = '203.0.113.20'

interface Counts {
  sessionUserSelects: number
  lastSeenWrites: number
}

/**
 * Wrap a DbClient so every top-level query (tagged-template AND `db.unsafe`)
 * is inspected. Queries issued inside `db.transaction(...)` run on the inner
 * client and are intentionally not counted — none of the paths under test
 * (`findUserBySessionHash`, the `last_seen_at` touch) run in a transaction.
 */
function countingDb(inner: DbClient): { db: DbClient; counts: Counts } {
  const counts: Counts = { sessionUserSelects: 0, lastSeenWrites: 0 }
  const inspect = (text: string): void => {
    const n = text.replace(/\s+/g, ' ').toLowerCase()
    if (n.includes('from sessions') && n.includes('join users')) counts.sessionUserSelects += 1
    if (n.includes('update sessions') && n.includes('last_seen_at')) counts.lastSeenWrites += 1
  }
  const wrapped = (async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    inspect(strings.join(' '))
    return inner<Row>(strings, ...values)
  }) as DbClient
  wrapped.unsafe = (async <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    inspect(sql)
    return inner.unsafe<Row>(sql, params)
  }) as DbClient['unsafe']
  wrapped.transaction = (fn) => inner.transaction(fn)
  Object.assign(wrapped, { dialect: inner.dialect })
  return { db: wrapped, counts }
}

async function setup(db: DbClient): Promise<void> {
  const res = await handleCmsRequest(
    new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'Ctx Test', email: EMAIL, password: PASSWORD }),
    }),
    db,
  )
  expect(res.status).toBe(201)
}

async function login(db: DbClient): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  stampSocketIp(req, IP)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

async function stepUp(db: DbClient, cookie: string): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  req.headers.set('cookie', cookie)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  const rotated = (res.headers.get('set-cookie') ?? '').split(';')[0]
  expect(rotated.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return rotated
}

function resetLimiters(): void {
  loginRateLimit.reset(`${IP}|${EMAIL}`)
  loginPerIpRateLimit.reset(IP)
  mfaRateLimit.reset(IP)
}

describe('Request-scoped auth context', () => {
  let testDb: { db: DbClient; cleanup: () => Promise<void> }

  beforeEach(async () => {
    testDb = await createTestDb()
    resetLimiters()
    await setup(testDb.db)
  })

  afterEach(async () => {
    await testDb.cleanup()
    resetLimiters()
  })

  it('resolves the session exactly once for a step-up-gated write', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const steppedCookie = await stepUp(db, cookie)

    // Measure only the gated write. requireCapability('users.manage') resolves
    // the session once; requireStepUp now reuses that AuthUser instead of
    // re-authenticating, so there must be exactly ONE session hydrate.
    const { db: measured, counts } = countingDb(db)
    const req = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'new-user@example.com',
        displayName: 'New User',
        password: PASSWORD,
        roleId: 'member',
      }),
    })
    req.headers.set('cookie', steppedCookie)
    const res = await handleCmsRequest(req, measured)
    expect(res.status).toBe(201)

    expect(counts.sessionUserSelects).toBe(1)
    expect(counts.lastSeenWrites).toBe(1)
  })

  it('writes last_seen_at at most once per request and debounces across requests', async () => {
    const { db } = testDb
    const cookie = await login(db)

    // First authenticated request: one hydrate, one debounced touch.
    const first = countingDb(db)
    const meReq1 = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    meReq1.headers.set('cookie', cookie)
    expect((await handleCmsRequest(meReq1, first.db)).status).toBe(200)
    expect(first.counts.sessionUserSelects).toBe(1)
    expect(first.counts.lastSeenWrites).toBe(1)

    // Second request on the same session, well within the debounce window:
    // the session is still hydrated, but the last_seen_at write is skipped.
    const second = countingDb(db)
    const meReq2 = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    meReq2.headers.set('cookie', cookie)
    expect((await handleCmsRequest(meReq2, second.db)).status).toBe(200)
    expect(second.counts.sessionUserSelects).toBe(1)
    expect(second.counts.lastSeenWrites).toBe(0)
  })

  it('debounce skips writes within the window and resumes after it elapses', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const idHash = await hashSessionToken(cookie.split('=')[1]!)
    const { db: measured, counts } = countingDb(db)

    const t0 = Date.now()
    // First touch for this hash always writes.
    expect(await findUserBySessionHash(measured, idHash, { now: t0 })).not.toBeNull()
    expect(counts.lastSeenWrites).toBe(1)

    // 10s later — inside the 30s window — the write is debounced away.
    expect(await findUserBySessionHash(measured, idHash, { now: t0 + 10_000 })).not.toBeNull()
    expect(counts.lastSeenWrites).toBe(1)

    // 40s after the first write — past the window — the write resumes.
    expect(await findUserBySessionHash(measured, idHash, { now: t0 + 40_000 })).not.toBeNull()
    expect(counts.lastSeenWrites).toBe(2)
  })

  it('does not extend session idle lifetime for passive socket delivery', async () => {
    const cookie = await login(testDb.db)
    const idHash = await hashSessionToken(cookie.split('=')[1]!)
    const { db: measured, counts } = countingDb(testDb.db)
    expect(await findUserBySessionHash(measured, idHash, { touchLastSeen: false })).not.toBeNull()
    expect(counts.sessionUserSelects).toBe(1)
    expect(counts.lastSeenWrites).toBe(0)
    await testDb.db`update sessions set last_seen_at = ${new Date(0)} where id_hash = ${idHash}`
    expect(await findUserBySessionHash(measured, idHash, { touchLastSeen: false })).toBeNull()
    expect(counts.lastSeenWrites).toBe(0)
  })

})
