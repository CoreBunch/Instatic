import { createTestDb } from '../helpers/createTestDb'
import { afterEach, describe, expect, it } from 'bun:test'
import { handleCmsRequest } from '../../../server/handlers/cms'
import type { DbClient } from '../../../server/db'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { loginRateLimit } from '../../../server/auth/rateLimit'
import { configurePublicOrigins, resetPublicOrigins, stampSocketIp } from '../../../server/auth/security'

afterEach(() => {
  resetPublicOrigins()
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function makeDb(): Promise<DbClient> {
  const test = await createTestDb()
  cleanups.push(test.cleanup)
  return test.db
}

async function records(db: DbClient, table: 'site' | 'users' | 'sessions' | 'audit_events') {
  const { rows } = await db.unsafe<Record<string, unknown>>(`select * from ${table}`)
  return rows
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

async function completeStepUp(
  db: DbClient,
  cookie: string,
  loginPhrase = 'long-enough-password',
): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/auth/step-up', {
    method: 'POST',
    body: JSON.stringify({ password: loginPhrase }),
    headers: { 'content-type': 'application/json' },
  })
  req.headers.set('cookie', cookie)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  const steppedCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  expect(steppedCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return steppedCookie
}

describe('CMS handlers', () => {
  it('reports setup status', async () => {
    const db = await makeDb()
    const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup/status'), db)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ hasSite: false, hasAdmin: false, hasOwner: false, needsSetup: true })
  })

  it('creates the first site and owner account', async () => {
    const db = await makeDb()
    const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ ok: true })
    expect((await records(db, 'site'))).toHaveLength(1)
    expect((await records(db, 'users'))).toHaveLength(1)
    expect((await records(db, 'users'))[0]).toMatchObject({ email_normalized: 'owner@example.com', role_id: 'owner', status: 'active' })
    expect((await records(db, 'audit_events'))[0]?.ip_address).toBeNull()
  })

  it('refuses setup after an owner exists', async () => {
    const db = await makeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'Existing', email: 'owner@example.com', password: 'long-enough-password' }),
    }), db)
    const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'new@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(409)
  })

  it('logs in and sets an HttpOnly session cookie', async () => {
    const db = await makeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginReq = new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    })
    stampSocketIp(loginReq, '203.0.113.77')
    const res = await handleCmsRequest(loginReq, db)
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('Path=/admin')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // Plain HTTP request → cookie must NOT carry the Secure flag, otherwise
    // browsers reject it.
    expect(cookie).not.toContain('Secure')
    expect((await records(db, 'sessions'))).toHaveLength(1)
    expect((await records(db, 'sessions'))[0]?.ip_address).toBe('203.0.113.77')
    expect((await records(db, 'audit_events')).at(-1)?.ip_address).toBe('203.0.113.77')
  })

  it('returns the current user with role capabilities', async () => {
    const db = await makeDb()
    const email = 'me-owner@example.com'
    loginRateLimit.reset(`unknown|${email}`)
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email, password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(loginRes.status).toBe(200)
    const cookie = await completeStepUp(db, (loginRes.headers.get('set-cookie') ?? '').split(';')[0])

    const meReq = new Request('http://localhost/admin/api/cms/me', {
      method: 'GET',
    })
    meReq.headers.set('cookie', cookie)
    const me = await handleCmsRequest(meReq, db)

    expect(me.status).toBe(200)
    expect(await json(me)).toMatchObject({
      user: {
        email,
        role: { slug: 'owner' },
        capabilities: expect.arrayContaining(['users.manage', 'roles.manage']),
      },
    })
    loginRateLimit.reset(`unknown|${email}`)
  })

  it('keeps owner setup-only when managing users', async () => {
    const db = await makeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner-only@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner-only@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const cookie = await completeStepUp(db, (loginRes.headers.get('set-cookie') ?? '').split(';')[0])
    const createReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'second-owner@example.com',
        displayName: 'Second Owner',
        password: 'another-long-password',
        roleId: 'owner',
      }),
      headers: { 'content-type': 'application/json' },
    })
    createReq.headers.set('cookie', cookie)

    const createRes = await handleCmsRequest(createReq, db)

    expect(createRes.status).toBe(400)
    expect(await json(createRes)).toEqual({ error: 'Owner role is setup-only' })
    expect((await records(db, 'users')).filter((user) => user.role_id === 'owner')).toHaveLength(1)
  })

  it('prevents assigning the owner role after setup and prevents owner self-demotion', async () => {
    const db = await makeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner-role@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner-role@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const cookie = await completeStepUp(db, (loginRes.headers.get('set-cookie') ?? '').split(';')[0])

    const createReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin-target@example.com',
        displayName: 'Admin Target',
        password: 'another-long-password',
        roleId: 'admin',
      }),
      headers: { 'content-type': 'application/json' },
    })
    createReq.headers.set('cookie', cookie)
    const createRes = await handleCmsRequest(createReq, db)
    expect(createRes.status).toBe(201)
    const created = await createRes.json() as { user: { id: string } }

    const assignOwnerReq = new Request(`http://localhost/admin/api/cms/users/${created.user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId: 'owner' }),
      headers: { 'content-type': 'application/json' },
    })
    assignOwnerReq.headers.set('cookie', cookie)
    const assignOwnerRes = await handleCmsRequest(assignOwnerReq, db)
    expect(assignOwnerRes.status).toBe(400)
    expect(await json(assignOwnerRes)).toEqual({ error: 'Owner role is setup-only' })

    const ownerId = String((await records(db, 'users')).find((user) => user.role_id === 'owner')?.id)
    const selfDemoteReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId: 'admin' }),
      headers: { 'content-type': 'application/json' },
    })
    selfDemoteReq.headers.set('cookie', cookie)
    const selfDemoteRes = await handleCmsRequest(selfDemoteReq, db)
    expect(selfDemoteRes.status).toBe(409)
    expect(await json(selfDemoteRes)).toEqual({ error: 'Owner cannot change their own role' })
  })

  it('prevents a non-owner admin from mutating the Owner row (password / email / delete)', async () => {
    // Regression test for F-0001: any actor with `users.manage` (admin role)
    // must NOT be able to PATCH the Owner row's password (Owner-takeover
    // primitive) or DELETE it. Only the Owner themself may mutate the Owner
    // row.
    const db = await makeDb()
    await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'real-owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const ownerLogin = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'real-owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const ownerCookie = await completeStepUp(db, (ownerLogin.headers.get('set-cookie') ?? '').split(';')[0])

    // Owner creates an admin co-worker.
    const createAdminReq = new Request('http://localhost/admin/api/cms/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'rogue-admin@example.com',
        displayName: 'Rogue Admin',
        password: 'rogue-admin-phrase',
        roleId: 'admin',
      }),
      headers: { 'content-type': 'application/json' },
    })
    createAdminReq.headers.set('cookie', ownerCookie)
    const createAdminRes = await handleCmsRequest(createAdminReq, db)
    expect(createAdminRes.status).toBe(201)

    const adminLogin = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'rogue-admin@example.com', password: 'rogue-admin-phrase' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const adminCookie = await completeStepUp(
      db,
      (adminLogin.headers.get('set-cookie') ?? '').split(';')[0],
      'rogue-admin-phrase',
    )

    const ownerId = String((await records(db, 'users')).find((user) => user.role_id === 'owner')?.id)
    const ownerHashBefore = (await records(db, 'users')).find((user) => user.role_id === 'owner')?.password_hash

    // Admin tries to overwrite the Owner's password — must be rejected with 403.
    const passwordPatchReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'attacker-chosen-password' }),
      headers: { 'content-type': 'application/json' },
    })
    passwordPatchReq.headers.set('cookie', adminCookie)
    const passwordPatchRes = await handleCmsRequest(passwordPatchReq, db)
    expect(passwordPatchRes.status).toBe(403)
    expect(await json(passwordPatchRes)).toEqual({ error: 'Only the owner can modify the owner account' })

    // Owner's password_hash must not have been touched.
    expect((await records(db, 'users')).find((user) => user.role_id === 'owner')?.password_hash).toBe(ownerHashBefore)

    // Admin tries to rewrite the Owner's email — also rejected.
    const emailPatchReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ email: 'hijacked@example.com' }),
      headers: { 'content-type': 'application/json' },
    })
    emailPatchReq.headers.set('cookie', adminCookie)
    const emailPatchRes = await handleCmsRequest(emailPatchReq, db)
    expect(emailPatchRes.status).toBe(403)
    expect((await records(db, 'users')).find((user) => user.role_id === 'owner')?.email).toBe('real-owner@example.com')

    // Admin tries to delete the Owner — rejected with 403, NOT the
    // "last active owner" 409 (we want the row-level guard to fire first
    // so the surface stays closed even if multi-owner is added later).
    const deleteReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'DELETE',
    })
    deleteReq.headers.set('cookie', adminCookie)
    const deleteRes = await handleCmsRequest(deleteReq, db)
    expect(deleteRes.status).toBe(403)
    expect(await json(deleteRes)).toEqual({ error: 'Only the owner can delete the owner account' })
    expect((await records(db, 'users')).find((user) => user.role_id === 'owner')?.deleted_at).toBeNull()

    // The Owner themself may still update their own row (e.g. rotate
    // password) — sanity check we didn't over-rotate.
    const selfPatchReq = new Request(`http://localhost/admin/api/cms/users/${ownerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ password: 'owner-rotated-password' }),
      headers: { 'content-type': 'application/json' },
    })
    selfPatchReq.headers.set('cookie', ownerCookie)
    const selfPatchRes = await handleCmsRequest(selfPatchReq, db)
    expect(selfPatchRes.status).toBe(200)
  })

  // ─── Secure cookie flag ─────────────────────────────────────────────────
  // Managed HTTPS platforms (and Caddy in compose.tls.yml) terminate TLS at the
  // edge and hand the container plain HTTP. The handler sets `Secure` from the
  // configured public origin's scheme — never from an untrusted
  // X-Forwarded-Proto header — so the cookie is reliably Secure on HTTPS
  // platforms. Direct HTTP requests with no https public origin must NOT get a
  // Secure cookie (which browsers would reject).
  describe('session cookie Secure flag', () => {
    async function loginThen(): Promise<string> {
      const db = await makeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      expect(res.status).toBe(200)
      return res.headers.get('set-cookie') ?? ''
    }

    it('sets Secure when an https public origin is configured (TLS terminated at the edge, req.url is http)', async () => {
      configurePublicOrigins(['https://cms.example.com'])
      const cookie = await loginThen()
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    })

    it('does NOT set Secure when the configured public origin is http', async () => {
      configurePublicOrigins(['http://cms.example.com'])
      const cookie = await loginThen()
      expect(cookie).not.toContain('Secure')
    })

    it('does NOT set Secure when no public origin is configured and the request is HTTP', async () => {
      const cookie = await loginThen()
      expect(cookie).not.toContain('Secure')
    })

    it('ignores a spoofed X-Forwarded-Proto: https when no https public origin is configured', async () => {
      const db = await makeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const res = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      }), db)
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie') ?? '').not.toContain('Secure')
    })

    it('logout cookie also gets Secure when an https public origin is configured', async () => {
      configurePublicOrigins(['https://cms.example.com'])
      const db = await makeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const loginRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const sessionCookie = (loginRes.headers.get('set-cookie') ?? '')
        .split(';')[0] // just `instatic_admin_session=<token>`

      const logoutRes = await handleCmsRequest(new Request('http://localhost/admin/api/cms/logout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie,
        },
      }), db)
      expect(logoutRes.status).toBe(200)
      const cookie = logoutRes.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('Max-Age=0')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
    })
  })

  // ─── Login rate limiting + constant-time + origin check ────────────────
  describe('login security', () => {
    /**
     * Make a login attempt with a unique XFF so the rate limit bucket key
     * doesn't bleed across tests.
     *
     * `Origin` is set on the constructed Headers post-hoc because happy-dom
     * (loaded via the test setup) strictly follows the Fetch spec's
     * "forbidden request headers" rule: passing `origin` in the Request
     * constructor's `headers` init silently drops it. In production, Bun.serve
     * receives the raw HTTP Origin header from the wire — no such filtering
     * applies. Mutating headers after Request construction works in both
     * environments, so we use that path here.
     */
    function loginRequest(email: string, password: string, ip: string, origin?: string): Request {
      const req = new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        headers: { 'content-type': 'application/json' },
      })
      stampSocketIp(req, ip)
      if (origin) req.headers.set('origin', origin)
      return req
    }

    async function makeDbWithAdmin() {
      const db = await makeDb()
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'X', email: 'owner@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      return db
    }

    it('rate-limits to 5 attempts per (IP, email), then returns 429 with Retry-After', async () => {
      // Use a unique IP+email so the singleton bucket starts fresh.
      const xff = '203.0.113.10'
      const email = 'rate-limit-test@example.com'
      loginRateLimit.reset(`${xff}|${email}`)

      const db = await makeDbWithAdmin()

      for (let i = 0; i < 5; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      const blocked = await handleCmsRequest(
        loginRequest(email, 'wrong-password', xff),
        db,
      )
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBeTruthy()
      const body = await blocked.json() as { error: string }
      expect(body.error).toMatch(/too many/i)

      // Cleanup so the bucket doesn't leak into other tests.
      loginRateLimit.reset(`${xff}|${email}`)
    })

    it('clears the bucket on successful login (forgotten password recovery flow)', async () => {
      const xff = '203.0.113.20'
      const email = 'owner@example.com'
      loginRateLimit.reset(`${xff}|${email}`)

      const db = await makeDbWithAdmin()

      // Three failed attempts.
      for (let i = 0; i < 3; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      // Successful login resets BOTH the rate-limit bucket and the
      // per-account failed-login counter (markUserLoggedIn sets the column to
      // 0 and clears locked_until).
      const ok = await handleCmsRequest(
        loginRequest(email, 'long-enough-password', xff),
        db,
      )
      expect(ok.status).toBe(200)

      // Now four more wrong attempts must still be allowed (rate-limit
      // bucket was cleared, lockout counter was zeroed). The 5th wrong
      // attempt would trigger the per-account lockout — that's a separate
      // concern covered by authLockoutLogin.test.ts.
      for (let i = 0; i < 4; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      loginRateLimit.reset(`${xff}|${email}`)
    })

    it('returns 401 (not 404) for an unknown email — same response shape as wrong-password', async () => {
      const xff = '203.0.113.30'
      const unknownEmail = 'does-not-exist@example.com'
      loginRateLimit.reset(`${xff}|${unknownEmail}`)
      loginRateLimit.reset(`${xff}|owner@example.com`)

      const db = await makeDbWithAdmin()

      // Unknown email (constant-time path runs argon2id verify against a dummy hash).
      const res = await handleCmsRequest(
        loginRequest(unknownEmail, 'long-enough-password', xff),
        db,
      )
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Invalid email or password')

      // Wrong password for an existing email should produce the EXACT same
      // response shape — no enumeration via different error messages.
      const res2 = await handleCmsRequest(
        loginRequest('owner@example.com', 'wrong-password', xff),
        db,
      )
      expect(res2.status).toBe(401)
      const body2 = await res2.json() as { error: string }
      expect(body2.error).toBe('Invalid email or password')

      loginRateLimit.reset(`${xff}|${unknownEmail}`)
      loginRateLimit.reset(`${xff}|owner@example.com`)
    })

    it('rejects state-changing requests with a foreign Origin (CSRF defense)', async () => {
      const db = await makeDbWithAdmin()
      const probe = loginRequest('owner@example.com', 'long-enough-password', '203.0.113.99', 'https://evil.example.com')
      // Sanity-assert that the test fixture builds the request we expect.
      expect(probe.headers.get('origin')).toBe('https://evil.example.com')
      expect(probe.method).toBe('POST')
      const res = await handleCmsRequest(probe, db)
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/origin/i)
    })

    it('accepts state-changing requests with no Origin (curl, server-to-server)', async () => {
      const db = await makeDbWithAdmin()
      // No `origin` header — must be allowed (covers curl/CLI/server-to-server).
      loginRateLimit.reset('203.0.113.40|owner@example.com')
      const res = await handleCmsRequest(
        loginRequest('owner@example.com', 'long-enough-password', '203.0.113.40'),
        db,
      )
      expect(res.status).toBe(200)
      loginRateLimit.reset('203.0.113.40|owner@example.com')
    })
  })
})
