/**
 * Integration tests — Account → Security endpoints.
 *
 * Covers self-service password changes, TOTP MFA enrollment, MFA-gated
 * login, and one-time recovery-code login against a real migrated SQLite DB.
 */
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { createSession } from '../../../server/auth/sessions'
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  sessionExpiry,
  verifyPassword,
} from '../../../server/auth/tokens'
import { loginPerIpRateLimit, loginRateLimit, mfaRateLimit } from '../../../server/auth/rateLimit'
import { stampSocketIp } from '../../../server/auth/security'
import { electAdapter } from '../../../server/repositories/mediaStorageAdapters'
import { createUser, findUserByEmail } from '../../../server/repositories/users'
import { mediaStorageRegistry } from '../../../src/core/plugins/mediaStorageRegistry'
import { createTestDb } from '../helpers/createTestDb'

const PASSWORD = 'long-enough-password'
const NEW_PASSWORD = 'new-long-enough-password'
const EMAIL = 'owner@example.com'
const IP = '203.0.113.10'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

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
      body: JSON.stringify({ siteName: 'Security Test', email: EMAIL, password: PASSWORD }),
    }),
    db,
  )
  expect(res.status).toBe(201)
}

async function login(
  db: DbClient,
  password = PASSWORD,
): Promise<{ cookie: string; body: Record<string, unknown> }> {
  const req = new Request('http://localhost/admin/api/cms/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password }),
  })
  stampSocketIp(req, IP)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return { cookie, body: await res.json() as Record<string, unknown> }
}

function cookieFromSetCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return cookie
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
  return cookieFromSetCookie(res)
}

async function enableMfa(
  db: DbClient,
  cookie: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const steppedCookie = await stepUp(db, cookie)
  const startReq = new Request('http://localhost/admin/api/cms/me/mfa/totp/start', {
    method: 'POST',
  })
  startReq.headers.set('cookie', steppedCookie)
  const startRes = await handleCmsRequest(startReq, db)
  expect(startRes.status).toBe(200)
  const startBody = await startRes.json() as { secret: string; otpauthUrl: string }
  expect(startBody.secret).toMatch(/^[A-Z2-7]+$/)
  expect(startBody.otpauthUrl).toContain(encodeURIComponent(EMAIL))

  const enableReq = new Request('http://localhost/admin/api/cms/me/mfa/totp/enable', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: startBody.secret, code: totpCode(startBody.secret) }),
  })
  enableReq.headers.set('cookie', steppedCookie)
  const enableRes = await handleCmsRequest(enableReq, db)
  expect(enableRes.status).toBe(200)
  const enableBody = await enableRes.json() as {
    user: { mfaEnabled: boolean; mfaRecoveryCodesRemaining: number }
    recoveryCodes: string[]
  }
  expect(enableBody.user.mfaEnabled).toBe(true)
  expect(enableBody.user.mfaRecoveryCodesRemaining).toBe(10)
  expect(enableBody.recoveryCodes).toHaveLength(10)

  return { secret: startBody.secret, recoveryCodes: enableBody.recoveryCodes }
}

function resetLimiters(): void {
  loginRateLimit.reset(`${IP}|${EMAIL}`)
  loginRateLimit.reset(`unknown|${EMAIL}`)
  loginPerIpRateLimit.reset(IP)
  mfaRateLimit.reset(IP)
  mfaRateLimit.reset('unknown')
}

describe('Account security endpoints', () => {
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

  it('PATCH /me requires step-up before updating profile basics', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const nextEmail = 'owner-renamed@example.com'

    const blockedReq = new Request('http://localhost/admin/api/cms/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Owner Renamed',
        email: nextEmail,
      }),
    })
    blockedReq.headers.set('cookie', cookie)
    const blockedRes = await handleCmsRequest(blockedReq, db)
    expect(blockedRes.status).toBe(401)
    expect(await blockedRes.json()).toEqual({ error: 'step_up_required' })
    expect(await findUserByEmail(db, nextEmail)).toBeNull()

    const steppedCookie = await stepUp(db, cookie)
    const updateReq = new Request('http://localhost/admin/api/cms/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Owner Renamed',
        email: nextEmail,
      }),
    })
    updateReq.headers.set('cookie', steppedCookie)
    const updateRes = await handleCmsRequest(updateReq, db)
    expect(updateRes.status).toBe(200)
    const body = await updateRes.json() as {
      user: { displayName: string; email: string; gravatarHash: string }
    }
    expect(body.user.displayName).toBe('Owner Renamed')
    expect(body.user.email).toBe(nextEmail)
    expect(body.user.gravatarHash).toHaveLength(64)

    const updated = await findUserByEmail(db, nextEmail)
    expect(updated?.displayName).toBe('Owner Renamed')
  })

  it('PATCH /me accepts the display-name length boundary and trims email before saving', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const steppedCookie = await stepUp(db, cookie)
    const displayName = 'A'.repeat(160)

    const updateReq = new Request('http://localhost/admin/api/cms/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName,
        email: '  owner-max@example.com  ',
      }),
    })
    updateReq.headers.set('cookie', steppedCookie)
    const updateRes = await handleCmsRequest(updateReq, db)
    expect(updateRes.status).toBe(200)
    const body = await updateRes.json() as {
      user: { displayName: string; email: string; gravatarHash: string }
    }
    expect(body.user.displayName).toBe(displayName)
    expect(body.user.email).toBe('owner-max@example.com')
    expect(body.user.gravatarHash).toHaveLength(64)

    const updated = await findUserByEmail(db, 'OWNER-MAX@example.com')
    expect(updated?.displayName).toBe(displayName)
    expect(updated?.email).toBe('owner-max@example.com')
  })

  it('PATCH /me rejects duplicate email without changing profile basics', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const before = await findUserByEmail(db, EMAIL)
    if (!before) throw new Error('Expected setup user')
    await createUser(db, {
      email: 'second@example.com',
      displayName: 'Second User',
      passwordHash: await hashPassword('second-long-enough-password'),
      roleId: 'admin',
    })
    const steppedCookie = await stepUp(db, cookie)

    const duplicateReq = new Request('http://localhost/admin/api/cms/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Owner Duplicate',
        email: '  SECOND@example.com  ',
      }),
    })
    duplicateReq.headers.set('cookie', steppedCookie)
    const duplicateRes = await handleCmsRequest(duplicateReq, db)
    expect(duplicateRes.status).toBe(400)
    expect(await duplicateRes.json()).toEqual({ error: 'Email is already in use' })

    const after = await findUserByEmail(db, EMAIL)
    expect(after?.displayName).toBe(before.displayName)
    expect(after?.email).toBe(before.email)
    expect(await findUserByEmail(db, 'second@example.com')).not.toBeNull()
  })

  it('PATCH /me rejects invalid profile payloads without changing profile basics', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const before = await findUserByEmail(db, EMAIL)
    if (!before) throw new Error('Expected setup user')
    const steppedCookie = await stepUp(db, cookie)
    const invalidCases: Array<{ body: Record<string, unknown>; error: string }> = [
      {
        body: { displayName: 'Owner Invalid', email: 'not-an-email' },
        error: 'Invalid email address',
      },
      {
        body: { displayName: 'A'.repeat(161), email: 'owner-too-long@example.com' },
        error: 'Invalid profile payload',
      },
      {
        body: { displayName: 'Owner Missing Email' },
        error: 'Invalid profile payload',
      },
    ]

    for (const invalidCase of invalidCases) {
      const invalidReq = new Request('http://localhost/admin/api/cms/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invalidCase.body),
      })
      invalidReq.headers.set('cookie', steppedCookie)
      const invalidRes = await handleCmsRequest(invalidReq, db)
      expect(invalidRes.status).toBe(400)
      expect(await invalidRes.json()).toEqual({ error: invalidCase.error })

      const after = await findUserByEmail(db, EMAIL)
      expect(after?.displayName).toBe(before.displayName)
      expect(after?.email).toBe(before.email)
    }
  })

  it('POST /me/avatar rejects an empty multipart body without changing the user avatar', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const before = await findUserByEmail(db, EMAIL)
    expect(before?.avatarMediaId).toBeNull()

    const emptyForm = new FormData()
    const uploadReq = new Request('http://localhost/admin/api/cms/me/avatar', {
      method: 'POST',
      body: emptyForm,
    })
    uploadReq.headers.set('cookie', cookie)
    const uploadRes = await handleCmsRequest(uploadReq, db)
    expect(uploadRes.status).toBe(400)
    expect(await uploadRes.json()).toEqual({ error: 'Missing file' })

    const after = await findUserByEmail(db, EMAIL)
    expect(after?.avatarMediaId).toBeNull()
  })

  it('DELETE /me/avatar is idempotent when the user has no uploaded avatar', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const before = await findUserByEmail(db, EMAIL)
    expect(before?.avatarMediaId).toBeNull()

    const removeReq = new Request('http://localhost/admin/api/cms/me/avatar', {
      method: 'DELETE',
    })
    removeReq.headers.set('cookie', cookie)
    const removeRes = await handleCmsRequest(removeReq, db)
    expect(removeRes.status).toBe(200)
    const removeBody = await removeRes.json() as {
      user: { avatarMediaId: string | null; avatarUrl: string | null; gravatarHash: string }
    }
    expect(removeBody.user.avatarMediaId).toBeNull()
    expect(removeBody.user.avatarUrl).toBeNull()
    expect(removeBody.user.gravatarHash).toHaveLength(64)

    const after = await findUserByEmail(db, EMAIL)
    expect(after?.avatarMediaId).toBeNull()
  })

  it('POST /me/avatar surfaces elected storage adapter failures without changing the user avatar', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const user = await findUserByEmail(db, EMAIL)
    if (!user) throw new Error('Expected setup user')
    expect(user.avatarMediaId).toBeNull()

    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-avatar-uploads-'))
    mediaStorageRegistry.configureLocalDisk({ uploadsDir })

    try {
      await electAdapter(db, 'avatar', 'missing.avatar', user.id)

      const form = new FormData()
      form.set('file', new File([PNG_1X1], 'avatar.png', { type: 'image/png' }))
      const uploadReq = new Request('http://localhost/admin/api/cms/me/avatar', {
        method: 'POST',
        body: form,
      })
      uploadReq.headers.set('cookie', cookie)
      const uploadRes = await handleCmsRequest(uploadReq, db)
      expect(uploadRes.status).toBe(503)
      expect(await uploadRes.json()).toEqual({
        error: 'Elected media storage adapter "missing.avatar" is not currently available for role "avatar". The plugin that provides it may be disabled.',
      })

      const after = await findUserByEmail(db, EMAIL)
      expect(after?.avatarMediaId).toBeNull()
      const { rows } = await db<{ count: number | string }>`select count(*) as count from media_assets`
      expect(Number(rows[0]?.count ?? 0)).toBe(0)
    } finally {
      mediaStorageRegistry.__reset()
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('PATCH /me/password requires step-up, changes the password, and revokes other sessions', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const user = await findUserByEmail(db, EMAIL)
    const otherToken = createSessionToken()
    const otherIdHash = await hashSessionToken(otherToken)
    await createSession(db, {
      idHash: otherIdHash,
      userId: user!.id,
      expiresAt: sessionExpiry(),
      ipAddress: '198.51.100.30',
      userAgent: null,
    })

    const blockedReq = new Request('http://localhost/admin/api/cms/me/password', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: NEW_PASSWORD }),
    })
    blockedReq.headers.set('cookie', cookie)
    const blockedRes = await handleCmsRequest(blockedReq, db)
    expect(blockedRes.status).toBe(401)
    expect(await blockedRes.json()).toEqual({ error: 'step_up_required' })

    const steppedCookie = await stepUp(db, cookie)
    const changeReq = new Request('http://localhost/admin/api/cms/me/password', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword: NEW_PASSWORD }),
    })
    changeReq.headers.set('cookie', steppedCookie)
    const changeRes = await handleCmsRequest(changeReq, db)
    expect(changeRes.status).toBe(200)
    const body = await changeRes.json() as { user: { passwordUpdatedAt: string } }
    expect(Date.parse(body.user.passwordUpdatedAt)).not.toBeNaN()

    const updated = await findUserByEmail(db, EMAIL)
    expect(await verifyPassword(NEW_PASSWORD, updated!.passwordHash)).toBe(true)
    expect(await verifyPassword(PASSWORD, updated!.passwordHash)).toBe(false)

    const revoked = await db<{ revoked_at: string | null }>`
      select revoked_at from sessions where id_hash = ${otherIdHash}
    `
    expect(revoked.rows[0]?.revoked_at).not.toBeNull()
  })

  it('PATCH /me/security/step-up updates the policy and disabled mode bypasses normal sensitive gates', async () => {
    const { db } = testDb
    const { cookie } = await login(db)

    const blockedReq = new Request('http://localhost/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'disabled', windowMinutes: 30 }),
    })
    blockedReq.headers.set('cookie', cookie)
    const blockedRes = await handleCmsRequest(blockedReq, db)
    expect(blockedRes.status).toBe(401)
    expect(await blockedRes.json()).toEqual({ error: 'step_up_required' })

    const steppedCookie = await stepUp(db, cookie)
    const updateReq = new Request('http://localhost/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'disabled', windowMinutes: 30 }),
    })
    updateReq.headers.set('cookie', steppedCookie)
    const updateRes = await handleCmsRequest(updateReq, db)
    expect(updateRes.status).toBe(200)
    const updateBody = await updateRes.json() as {
      user: { stepUpAuthMode: string; stepUpWindowMinutes: number }
    }
    expect(updateBody.user.stepUpAuthMode).toBe('disabled')
    expect(updateBody.user.stepUpWindowMinutes).toBe(30)

    const fresh = await login(db)
    const logoutAllReq = new Request('http://localhost/admin/api/cms/auth/logout-all', {
      method: 'POST',
    })
    logoutAllReq.headers.set('cookie', fresh.cookie)
    const logoutAllRes = await handleCmsRequest(logoutAllReq, db)
    expect(logoutAllRes.status).toBe(200)

    const reenableReq = new Request('http://localhost/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'required', windowMinutes: 15 }),
    })
    reenableReq.headers.set('cookie', fresh.cookie)
    const reenableRes = await handleCmsRequest(reenableReq, db)
    expect(reenableRes.status).toBe(401)
    expect(await reenableRes.json()).toEqual({ error: 'step_up_required' })
  })

  it('PATCH /me/security/step-up rejects unsupported policy values without changing settings', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const steppedCookie = await stepUp(db, cookie)

    const invalidModeReq = new Request('http://localhost/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'optional', windowMinutes: 30 }),
    })
    invalidModeReq.headers.set('cookie', steppedCookie)
    const invalidModeRes = await handleCmsRequest(invalidModeReq, db)
    expect(invalidModeRes.status).toBe(400)
    expect(await invalidModeRes.json()).toEqual({ error: 'Invalid step-up settings' })

    const invalidWindowReq = new Request('http://localhost/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'required', windowMinutes: 999 }),
    })
    invalidWindowReq.headers.set('cookie', steppedCookie)
    const invalidWindowRes = await handleCmsRequest(invalidWindowReq, db)
    expect(invalidWindowRes.status).toBe(400)
    expect(await invalidWindowRes.json()).toEqual({ error: 'Invalid step-up settings' })

    const unchanged = await findUserByEmail(db, EMAIL)
    expect(unchanged?.stepUpAuthMode).toBe('required')
    expect(unchanged?.stepUpWindowMinutes).toBe(15)
  })

  it('uses the configured step-up window when re-authenticating', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const steppedCookie = await stepUp(db, cookie)

    const updateReq = new Request('http://localhost/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'required', windowMinutes: 30 }),
    })
    updateReq.headers.set('cookie', steppedCookie)
    const updateRes = await handleCmsRequest(updateReq, db)
    expect(updateRes.status).toBe(200)

    const before = Date.now()
    const secondStepUpReq = new Request('http://localhost/admin/api/cms/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    secondStepUpReq.headers.set('cookie', steppedCookie)
    const secondStepUpRes = await handleCmsRequest(secondStepUpReq, db)
    expect(secondStepUpRes.status).toBe(200)
    const body = await secondStepUpRes.json() as { stepUpExpiresAt: string }
    const expiresAt = Date.parse(body.stepUpExpiresAt)
    const thirtyMinutesMs = 30 * 60 * 1000
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyMinutesMs - 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + thirtyMinutesMs + 1000)
  })

  it('enables TOTP MFA and blocks normal authenticated APIs until the second factor verifies', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const { secret } = await enableMfa(db, cookie)

    const schemaRows = db.dialect === 'sqlite'
      ? await db.unsafe<{ name: string }>("select name from pragma_table_info('users')")
      : await db.unsafe<{ name: string }>(
        "select column_name as name from information_schema.columns where table_name = 'users'",
      )
    const userColumns = schemaRows.rows.map((row) => row.name)
    expect(userColumns).not.toContain('mfa_totp_secret')

    const storedRows = await db<{
      mfa_totp_secret_ciphertext: Uint8Array | null
      mfa_totp_secret_iv: Uint8Array | null
      mfa_totp_secret_key_fingerprint: string | null
    }>`
      select mfa_totp_secret_ciphertext, mfa_totp_secret_iv, mfa_totp_secret_key_fingerprint
      from users
      where email_normalized = ${EMAIL}
      limit 1
    `
    const stored = storedRows.rows[0]
    expect(stored?.mfa_totp_secret_ciphertext).toBeInstanceOf(Uint8Array)
    expect(stored?.mfa_totp_secret_iv).toBeInstanceOf(Uint8Array)
    expect(stored?.mfa_totp_secret_key_fingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(new TextDecoder().decode(stored!.mfa_totp_secret_ciphertext!)).not.toContain(secret)

    const pending = await login(db)
    expect(pending.body.mfaRequired).toBe(true)

    const meReq = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    meReq.headers.set('cookie', pending.cookie)
    const meRes = await handleCmsRequest(meReq, db)
    expect(meRes.status).toBe(401)
    expect(await meRes.json()).toEqual({ error: 'mfa_required' })

    const verifyReq = new Request('http://localhost/admin/api/cms/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: totpCode(secret) }),
    })
    verifyReq.headers.set('cookie', pending.cookie)
    const verifyRes = await handleCmsRequest(verifyReq, db)
    expect(verifyRes.status).toBe(200)
    expect(await verifyRes.json()).toEqual({ ok: true })
    const verifiedCookie = cookieFromSetCookie(verifyRes)
    expect(verifiedCookie).not.toBe(pending.cookie)

    const oldCookieMeReq = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    oldCookieMeReq.headers.set('cookie', pending.cookie)
    const oldCookieMeRes = await handleCmsRequest(oldCookieMeReq, db)
    expect(oldCookieMeRes.status).toBe(401)

    const verifiedMeReq = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    verifiedMeReq.headers.set('cookie', verifiedCookie)
    const verifiedMeRes = await handleCmsRequest(verifiedMeReq, db)
    expect(verifiedMeRes.status).toBe(200)
  })

  it('rejects expired pending MFA sessions before verification', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const { secret } = await enableMfa(db, cookie)

    const pending = await login(db)
    expect(pending.body.mfaRequired).toBe(true)
    const pendingToken = pending.cookie.split('=')[1]
    if (!pendingToken) throw new Error('Pending MFA login did not return a session token')
    const pendingIdHash = await hashSessionToken(pendingToken)
    await db`
      update sessions
      set expires_at = ${new Date(Date.now() - 1000)}
      where id_hash = ${pendingIdHash}
    `

    const verifyReq = new Request('http://localhost/admin/api/cms/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: totpCode(secret) }),
    })
    verifyReq.headers.set('cookie', pending.cookie)
    const verifyRes = await handleCmsRequest(verifyReq, db)
    expect(verifyRes.status).toBe(401)
    expect(await verifyRes.json()).toEqual({ error: 'Unauthorized' })
    expect(verifyRes.headers.get('set-cookie')).toBeNull()

    const meReq = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
    meReq.headers.set('cookie', pending.cookie)
    const meRes = await handleCmsRequest(meReq, db)
    expect(meRes.status).toBe(401)
    expect(await meRes.json()).toEqual({ error: 'Unauthorized' })
  })

  it('rejects unknown MFA session cookies before verification', async () => {
    const { db } = testDb
    const unknownCookies = [
      `${SESSION_COOKIE_NAME}=not-a-real-pending-session-token`,
      `${SESSION_COOKIE_NAME}=${createSessionToken()}`,
    ]

    for (const unknownCookie of unknownCookies) {
      const verifyReq = new Request('http://localhost/admin/api/cms/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456' }),
      })
      verifyReq.headers.set('cookie', unknownCookie)
      const verifyRes = await handleCmsRequest(verifyReq, db)
      expect(verifyRes.status).toBe(401)
      expect(await verifyRes.json()).toEqual({ error: 'Unauthorized' })
      expect(verifyRes.headers.get('set-cookie')).toBeNull()

      const meReq = new Request('http://localhost/admin/api/cms/me', { method: 'GET' })
      meReq.headers.set('cookie', unknownCookie)
      const meRes = await handleCmsRequest(meReq, db)
      expect(meRes.status).toBe(401)
      expect(await meRes.json()).toEqual({ error: 'Unauthorized' })
    }
  })

  it('locks the account after repeated failed MFA codes — even a correct code is then rejected (ISS-001)', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const { secret } = await enableMfa(db, cookie)

    const pending = await login(db)
    expect(pending.body.mfaRequired).toBe(true)

    const postMfa = async (code: string) => {
      const r = new Request('http://localhost/admin/api/cms/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      r.headers.set('cookie', pending.cookie)
      return handleCmsRequest(r, db)
    }

    // LOCKOUT_THRESHOLD (5) wrong codes must trip the per-account lockout.
    for (let i = 0; i < 5; i++) {
      const res = await postMfa('000000')
      expect(res.status).toBe(401)
    }

    // The account is now locked: a CORRECT TOTP code must be refused (429),
    // proving MFA failures feed the per-account lockout so distributed brute
    // force can no longer grind indefinitely.
    const lockedRes = await postMfa(totpCode(secret))
    expect(lockedRes.status).toBe(429)
  })

  it('accepts one recovery code during MFA login and burns it after use', async () => {
    const { db } = testDb
    const { cookie } = await login(db)
    const { recoveryCodes } = await enableMfa(db, cookie)
    const recoveryCode = recoveryCodes[0]!

    const pending = await login(db)
    const verifyReq = new Request('http://localhost/admin/api/cms/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: recoveryCode }),
    })
    verifyReq.headers.set('cookie', pending.cookie)
    const verifyRes = await handleCmsRequest(verifyReq, db)
    expect(verifyRes.status).toBe(200)
    expect(cookieFromSetCookie(verifyRes)).not.toBe(pending.cookie)

    const user = await findUserByEmail(db, EMAIL)
    expect(user?.mfaRecoveryCodesRemaining).toBe(9)

    const pendingAgain = await login(db)
    const reuseReq = new Request('http://localhost/admin/api/cms/auth/mfa/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: recoveryCode }),
    })
    reuseReq.headers.set('cookie', pendingAgain.cookie)
    const reuseRes = await handleCmsRequest(reuseReq, db)
    expect(reuseRes.status).toBe(401)
  })
})
