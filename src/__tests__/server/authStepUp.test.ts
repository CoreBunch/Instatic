/**
 * Integration tests — step-up auth.
 *
 * Exercises POST /admin/api/cms/auth/step-up plus the three sensitive
 * endpoints it gates (DELETE users/:id, DELETE auth/sessions/:id,
 * POST auth/logout-all) against a real SQLite test DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { findUserByEmail } from '../../../server/repositories/users'
import { listAuditEvents } from '../../../server/repositories/audit'
import { createSession } from '../../../server/auth/sessions'
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashSessionToken,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { loginPerIpRateLimit, loginRateLimit, mfaRateLimit } from '../../../server/auth/rateLimit'
import { stampSocketIp } from '../../../server/auth/security'
import { STEP_UP_DEFAULT_WINDOW_MS } from '../../../server/auth/stepUpPolicy'
import { createTestDb } from '../helpers/createTestDb'
import { createHmac } from 'node:crypto'

const VALID_LOGIN_PHRASE = 'long-enough-phrase'
const EMAIL = 'owner@example.com'
const IP = '203.0.113.10'
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(secret: string): Buffer {
  let bits = ''
  for (const char of secret.replace(/=+$/g, '').toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value < 0) throw new Error(`Invalid base32 character ${char}`)
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

function totpCode(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 30_000)
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const value = (
    ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  ) % 1_000_000
  return value.toString().padStart(6, '0')
}

async function setup(db: DbClient): Promise<void> {
  const res = await handleCmsRequest(
    new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'StepUp Test', email: EMAIL, password: VALID_LOGIN_PHRASE }),
    }),
    db,
  )
  expect(res.status).toBe(201)
}

async function login(db: DbClient): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: VALID_LOGIN_PHRASE }),
  })
  stampSocketIp(req, IP)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]
}

async function stepUp(
  db: DbClient,
  cookie: string,
  password: string,
  mfaCode?: string,
): Promise<Response> {
  const req = new Request('http://localhost/admin/api/cms/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, ...(mfaCode ? { mfaCode } : {}) }),
  })
  stampSocketIp(req, IP)
  req.headers.set('cookie', cookie)
  return handleCmsRequest(req, db)
}

function cookieFromSetCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return cookie
}

async function completeStepUp(
  db: DbClient,
  cookie: string,
  password: string,
  mfaCode?: string,
): Promise<string> {
  const res = await stepUp(db, cookie, password, mfaCode)
  expect(res.status).toBe(200)
  return cookieFromSetCookie(res)
}

async function enableMfa(db: DbClient, cookie: string): Promise<{ cookie: string; recoveryCodes: string[] }> {
  const stepUpRes = await stepUp(db, cookie, VALID_LOGIN_PHRASE)
  expect(stepUpRes.status).toBe(200)
  const steppedCookie = cookieFromSetCookie(stepUpRes)

  const enableReq = new Request('http://localhost/admin/api/cms/me/mfa/totp/enable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: TOTP_SECRET, code: totpCode(TOTP_SECRET) }),
  })
  enableReq.headers.set('cookie', steppedCookie)
  const enableRes = await handleCmsRequest(enableReq, db)
  expect(enableRes.status).toBe(200)
  const enableBody = await enableRes.json() as { recoveryCodes: string[] }

  await db`
    update sessions
    set step_up_expires_at = ${new Date(Date.now() - 1000)}
  `

  return { cookie: steppedCookie, recoveryCodes: enableBody.recoveryCodes }
}

async function logoutAll(db: DbClient, cookie: string): Promise<Response> {
  const req = new Request('http://localhost/admin/api/cms/auth/logout-all', { method: 'POST' })
  req.headers.set('cookie', cookie)
  return handleCmsRequest(req, db)
}

function resetLimiters(): void {
  loginRateLimit.reset(`${IP}|${EMAIL}`)
  loginRateLimit.reset(`unknown|${EMAIL}`)
  loginPerIpRateLimit.reset(IP)
  mfaRateLimit.reset(IP)
  mfaRateLimit.reset('unknown')
}

describe('Step-up auth', () => {
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

  it('POST /step-up with the correct password opens the default window', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const before = Date.now()

    const res = await stepUp(db, cookie, VALID_LOGIN_PHRASE)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; stepUpExpiresAt: string }
    expect(body.ok).toBe(true)
    expect(cookieFromSetCookie(res)).not.toBe(cookie)

    const expiresAt = Date.parse(body.stepUpExpiresAt)
    expect(expiresAt).toBeGreaterThanOrEqual(before + STEP_UP_DEFAULT_WINDOW_MS - 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + STEP_UP_DEFAULT_WINDOW_MS + 1000)
  })

  it('POST /step-up rotates the session token and revokes the old token', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const oldToken = cookie.split('=')[1]!
    const oldHash = await hashSessionToken(oldToken)

    const res = await stepUp(db, cookie, VALID_LOGIN_PHRASE)
    expect(res.status).toBe(200)
    const rotatedCookie = cookieFromSetCookie(res)
    const newToken = rotatedCookie.split('=')[1]!
    const newHash = await hashSessionToken(newToken)

    expect(newHash).not.toBe(oldHash)

    const oldSession = await db<{ revoked_at: string | null }>`
      select revoked_at from sessions where id_hash = ${oldHash}
    `
    expect(oldSession.rows[0]?.revoked_at).not.toBeNull()

    const newSession = await db<{ revoked_at: string | null; step_up_expires_at: string | null }>`
      select revoked_at, step_up_expires_at from sessions where id_hash = ${newHash}
    `
    expect(newSession.rows[0]?.revoked_at).toBeNull()
    expect(newSession.rows[0]?.step_up_expires_at).not.toBeNull()
  })

  it('successful step-up clears the per-IP limiter for repeated protected actions', async () => {
    const { db } = testDb
    let cookie = await login(db)

    // Reach the last allowed attempt without repeating expensive password
    // verification 35 times. Without the success reset, the second request
    // below exceeds the limit and returns 429.
    for (let i = 0; i < 29; i += 1) expect(loginPerIpRateLimit.consume(IP).ok).toBe(true)
    cookie = await completeStepUp(db, cookie, VALID_LOGIN_PHRASE)
    await completeStepUp(db, cookie, VALID_LOGIN_PHRASE)
  })

  it('POST /step-up for an MFA-enabled account requires a second-factor code', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const { cookie: mfaCookie } = await enableMfa(db, cookie)

    const res = await stepUp(db, mfaCookie, VALID_LOGIN_PHRASE)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Authentication code required' })
  })

  it('POST /step-up for an MFA-enabled account accepts a valid TOTP code', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const { cookie: mfaCookie } = await enableMfa(db, cookie)

    const before = Date.now()
    const res = await stepUp(db, mfaCookie, VALID_LOGIN_PHRASE, totpCode(TOTP_SECRET))
    expect(res.status).toBe(200)
    expect(cookieFromSetCookie(res)).not.toBe(mfaCookie)
    const body = await res.json() as {
      ok: boolean
      stepUpExpiresAt: string
      user: { mfaEnabled: boolean }
    }
    expect(body.ok).toBe(true)
    expect(body.user.mfaEnabled).toBe(true)
    expect(Date.parse(body.stepUpExpiresAt)).toBeGreaterThanOrEqual(before + STEP_UP_DEFAULT_WINDOW_MS - 1000)
  })

  it('POST /step-up for an MFA-enabled account accepts and burns a recovery code', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const { cookie: mfaCookie, recoveryCodes } = await enableMfa(db, cookie)
    const recoveryCode = recoveryCodes[0]!

    const res = await stepUp(db, mfaCookie, VALID_LOGIN_PHRASE, recoveryCode)
    expect(res.status).toBe(200)
    const rotatedCookie = cookieFromSetCookie(res)
    const body = await res.json() as {
      ok: boolean
      user: { mfaRecoveryCodesRemaining: number }
    }
    expect(body.ok).toBe(true)
    expect(body.user.mfaRecoveryCodesRemaining).toBe(9)

    await db`
      update sessions
      set step_up_expires_at = ${new Date(Date.now() - 1000)}
    `

    const reuseRes = await stepUp(db, rotatedCookie, VALID_LOGIN_PHRASE, recoveryCode)
    expect(reuseRes.status).toBe(401)
    expect(await reuseRes.json()).toEqual({ error: 'Invalid authentication code' })
  })

  it('POST /step-up for an MFA-enabled account rejects an invalid second-factor code', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const { cookie: mfaCookie } = await enableMfa(db, cookie)

    const res = await stepUp(db, mfaCookie, VALID_LOGIN_PHRASE, '000000')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid authentication code' })
  })

  it('POST /step-up with the wrong password returns 401 and emits a login.failure audit', async () => {
    const { db } = testDb
    const cookie = await login(db)

    const res = await stepUp(db, cookie, 'completely-wrong-password')
    expect(res.status).toBe(401)

    const events = await listAuditEvents(db)
    const stepUpFailures = events.filter((event) =>
      event.action === 'login.failure' && event.metadata.reason === 'step_up'
    )
    expect(stepUpFailures).toHaveLength(1)
  })

  it('POST /step-up wrong password attempts increment lockout and eventually lock the account', async () => {
    const { db } = testDb
    const cookie = await login(db)

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const res = await stepUp(db, cookie, 'completely-wrong-password')
      expect(res.status).toBe(401)
    }

    const lockedRes = await stepUp(db, cookie, 'completely-wrong-password')
    expect(lockedRes.status).toBe(423)
    expect(lockedRes.headers.get('retry-after')).not.toBeNull()

    const user = await findUserByEmail(db, EMAIL)
    expect(user?.failedLoginCount).toBe(5)
    expect(user?.lockedUntil).not.toBeNull()
  })

  it('POST /step-up when the account is locked returns 423 with Retry-After', async () => {
    const { db } = testDb
    const cookie = await login(db)

    const user = await findUserByEmail(db, EMAIL)
    // Manually push the account into a locked state — the lockout policy
    // already has end-to-end coverage in authLockoutLogin.test.ts.
    const lockedUntil = new Date(Date.now() + 60_000).toISOString()
    await db`update users set locked_until = ${lockedUntil} where id = ${user!.id}`

    const res = await stepUp(db, cookie, VALID_LOGIN_PHRASE)
    expect(res.status).toBe(423)
    expect(res.headers.get('retry-after')).not.toBeNull()
  })

  it('logout-all rejects with 401 step_up_required when no fresh window exists', async () => {
    const { db } = testDb
    const cookie = await login(db)

    const res = await logoutAll(db, cookie)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('step_up_required')
  })

  it('logout-all succeeds after a successful step-up', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const steppedCookie = await completeStepUp(db, cookie, VALID_LOGIN_PHRASE)

    const res = await logoutAll(db, steppedCookie)
    expect(res.status).toBe(200)
  })

  it('DELETE /auth/sessions/:id rejects without a fresh window', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const user = await findUserByEmail(db, EMAIL)
    // Inject a sibling session to revoke.
    const otherToken = createSessionToken()
    const otherIdHash = await hashSessionToken(otherToken)
    await createSession(db, {
      idHash: otherIdHash,
      userId: user!.id,
      expiresAt: sessionExpiry(),
      ipAddress: '198.51.100.30',
      userAgent: null,
    })

    const req = new Request(`http://localhost/admin/api/cms/auth/sessions/${otherIdHash}`, {
      method: 'DELETE',
    })
    req.headers.set('cookie', cookie)
    const res = await handleCmsRequest(req, db)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('step_up_required')

    // Sibling session is still alive — was NOT revoked.
    const remaining = await db`select revoked_at from sessions where id_hash = ${otherIdHash}`
    expect(remaining.rows[0]?.revoked_at).toBeNull()
  })

  it('DELETE /users/:id rejects without a fresh window', async () => {
    const { db } = testDb
    const ownerCookie = await login(db)
    // Create a target admin user via the API.
    const steppedOwnerCookie = await completeStepUp(db, ownerCookie, VALID_LOGIN_PHRASE)
    const createReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'target@example.com',
        displayName: 'Target',
        password: VALID_LOGIN_PHRASE,
        roleId: 'admin',
      }),
    })
    createReq.headers.set('cookie', steppedOwnerCookie)
    const createRes = await handleCmsRequest(createReq, db)
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { user: { id: string } }

    // Roll the step-up window backwards so the next call is gated again.
    await db`
      update sessions
      set step_up_expires_at = ${new Date(Date.now() - 1000)}
    `

    const deleteReq = new Request(`http://localhost/admin/api/cms/users/${created.user.id}`, {
      method: 'DELETE',
    })
    deleteReq.headers.set('cookie', steppedOwnerCookie)
    const deleteRes = await handleCmsRequest(deleteReq, db)
    expect(deleteRes.status).toBe(401)
    const body = await deleteRes.json() as { error: string }
    expect(body.error).toBe('step_up_required')
  })

  it('user and role mutations reject without a fresh step-up window', async () => {
    const { db } = testDb
    const cookie = await login(db)

    const createUserReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'target@example.com',
        displayName: 'Target',
        password: VALID_LOGIN_PHRASE,
        roleId: 'admin',
      }),
    })
    createUserReq.headers.set('cookie', cookie)
    const createUserRes = await handleCmsRequest(createUserReq, db)
    expect(createUserRes.status).toBe(401)
    expect(await createUserRes.json()).toEqual({ error: 'step_up_required' })

    const createRoleReq = new Request('http://localhost/admin/api/cms/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Operators',
        description: 'Can operate account settings',
        capabilities: ['users.manage'],
      }),
    })
    createRoleReq.headers.set('cookie', cookie)
    const createRoleRes = await handleCmsRequest(createRoleReq, db)
    expect(createRoleRes.status).toBe(401)
    expect(await createRoleRes.json()).toEqual({ error: 'step_up_required' })
  })

  it('user and role update/delete mutations reject after the step-up window expires', async () => {
    const { db } = testDb
    const cookie = await login(db)
    const steppedCookie = await completeStepUp(db, cookie, VALID_LOGIN_PHRASE)

    const createUserReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'patch-target@example.com',
        displayName: 'Patch Target',
        password: VALID_LOGIN_PHRASE,
        roleId: 'member',
      }),
    })
    createUserReq.headers.set('cookie', steppedCookie)
    const createUserRes = await handleCmsRequest(createUserReq, db)
    expect(createUserRes.status).toBe(201)
    const createdUser = await createUserRes.json() as { user: { id: string } }

    const createRoleReq = new Request('http://localhost/admin/api/cms/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Temporary Operators',
        description: 'Temporary role',
        capabilities: ['site.read'],
      }),
    })
    createRoleReq.headers.set('cookie', steppedCookie)
    const createRoleRes = await handleCmsRequest(createRoleReq, db)
    expect(createRoleRes.status).toBe(201)
    const createdRole = await createRoleRes.json() as { role: { id: string } }

    await db`
      update sessions
      set step_up_expires_at = ${new Date(Date.now() - 1000)}
    `

    const patchUserReq = new Request(`http://localhost/admin/api/cms/users/${createdUser.user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    })
    patchUserReq.headers.set('cookie', steppedCookie)
    const patchUserRes = await handleCmsRequest(patchUserReq, db)
    expect(patchUserRes.status).toBe(401)
    expect(await patchUserRes.json()).toEqual({ error: 'step_up_required' })

    const patchRoleReq = new Request(`http://localhost/admin/api/cms/roles/${createdRole.role.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities: ['users.manage'] }),
    })
    patchRoleReq.headers.set('cookie', steppedCookie)
    const patchRoleRes = await handleCmsRequest(patchRoleReq, db)
    expect(patchRoleRes.status).toBe(401)
    expect(await patchRoleRes.json()).toEqual({ error: 'step_up_required' })

    const deleteRoleReq = new Request(`http://localhost/admin/api/cms/roles/${createdRole.role.id}`, {
      method: 'DELETE',
    })
    deleteRoleReq.headers.set('cookie', steppedCookie)
    const deleteRoleRes = await handleCmsRequest(deleteRoleReq, db)
    expect(deleteRoleRes.status).toBe(401)
    expect(await deleteRoleRes.json()).toEqual({ error: 'step_up_required' })
  })

  it('admin password reset stamps passwordUpdatedAt and revokes the target user sessions', async () => {
    const { db } = testDb
    const ownerCookie = await login(db)
    const steppedOwnerCookie = await completeStepUp(db, ownerCookie, VALID_LOGIN_PHRASE)

    const createUserReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'reset-target@example.com',
        displayName: 'Reset Target',
        password: VALID_LOGIN_PHRASE,
        roleId: 'member',
      }),
    })
    createUserReq.headers.set('cookie', steppedOwnerCookie)
    const createUserRes = await handleCmsRequest(createUserReq, db)
    expect(createUserRes.status).toBe(201)
    const created = await createUserRes.json() as { user: { id: string } }

    const targetLoginReq = new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'reset-target@example.com', password: VALID_LOGIN_PHRASE }),
    })
    stampSocketIp(targetLoginReq, IP)
    const targetLogin = await handleCmsRequest(targetLoginReq, db)
    expect(targetLogin.status).toBe(200)
    const targetCookie = (targetLogin.headers.get('set-cookie') ?? '').split(';')[0]
    expect(targetCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)

    const resetReq = new Request(`http://localhost/admin/api/cms/users/${created.user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-reset-target-password' }),
    })
    resetReq.headers.set('cookie', steppedOwnerCookie)
    const resetRes = await handleCmsRequest(resetReq, db)
    expect(resetRes.status).toBe(200)
    const resetBody = await resetRes.json() as { user: { passwordUpdatedAt: string | null } }
    expect(resetBody.user.passwordUpdatedAt).not.toBeNull()

    const oldSessionReq = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    oldSessionReq.headers.set('cookie', targetCookie)
    const oldSessionRes = await handleCmsRequest(oldSessionReq, db)
    expect(oldSessionRes.status).toBe(401)
  })
})
