import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { DEFAULT_MEMBER_SETTINGS, type CurrentMember } from '@core/members'
import { configurePublicOrigins, resetPublicOrigins, stampSocketIp } from '../../../server/auth/security'
import { handleMemberRequest, safeRedirectPath } from '../../../server/members/handlers'
import { resetMemberLimits } from '../../../server/members/limits'
import { flushMemberMail } from '../../../server/members/mail'
import {
  createMember,
  findMemberByEmail,
  grantMemberTag,
  listActiveMemberTags,
  revokeMemberTag,
  saveMemberSettings,
} from '../../../server/members/repository'
import { issueMemberToken } from '../../../server/members/tokens'
import {
  deleteMemberAsAdmin,
  getMemberForAdmin,
  inviteMember,
  listMembersForAdmin,
  setMemberSuspended,
} from '../../../server/members/admin'
import { publishMemberPages } from '../helpers/memberPages'

const ORIGIN = 'http://localhost'
const PASSWORD = 'correct-horse-battery'
const OTHER_PASSWORD = 'attacker-chosen-pass'

interface CallOptions {
  cookie?: string
  json?: boolean
  headers?: Record<string, string>
  origin?: string | null
  base?: string
}

/** A browser: remembers the cookies the server sets, like a cookie jar. */
class Browser {
  private jar = new Map<string, string>()

  constructor(private readonly db: TestDb['db']) {}

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private remember(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (value === '' || /max-age=0/i.test(line)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
  }

  async post(action: string, fields: Record<string, string>, options: CallOptions = {}): Promise<Response> {
    const base = options.base ?? ORIGIN
    const headers = new Headers(options.headers)
    const origin = options.origin === undefined ? base : options.origin
    if (origin) headers.set('origin', origin)
    const cookie = options.cookie ?? this.cookie
    if (cookie) headers.set('cookie', cookie)
    let body: string
    if (options.json === false) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      body = new URLSearchParams(fields).toString()
    } else {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(fields)
    }
    const url = new URL(`/_instatic/members/${action}`, base)
    // Set headers after construction: the test DOM's Request drops `origin`
    // and `cookie` from an init object, as a browser would.
    const req = new Request(url, { method: 'POST', body })
    headers.forEach((value, name) => req.headers.set(name, value))
    const res = await handleMemberRequest(req, this.db, url)
    this.remember(res)
    return res
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const url = new URL(`/_instatic/members/${path}`, ORIGIN)
    const req = requestWithCookie(url, this.cookie)
    for (const [name, value] of Object.entries(headers)) req.headers.set(name, value)
    const res = await handleMemberRequest(req, this.db, url)
    this.remember(res)
    return res
  }

  async me(): Promise<CurrentMember | null> {
    const body = (await (await this.get('me')).json()) as { member: CurrentMember | null }
    return body.member
  }
}

function requestWithCookie(url: URL, cookie: string): Request {
  const req = new Request(url)
  if (cookie) req.headers.set('cookie', cookie)
  return req
}

interface ErrorBody {
  ok: false
  error: { code: string; message: string; field?: string }
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ErrorBody).error.code
}

/** The owner's own page for every member link; without one, that link's feature is off. */
const PAGES = {
  login: '/sign-in',
  verify: '/welcome',
  reset: '/new-password',
  magic: '/sign-in-link',
  invite: '/invitation',
  emailChange: '/confirm-email',
}

describe('site members', () => {
  let t: TestDb
  let browser: Browser

  beforeEach(async () => {
    t = await createTestDb()
    // `DB=postgres` runs share one database across tests; start each one clean.
    for (const table of ['member_events', 'member_tags', 'member_tokens', 'member_sessions', 'members', 'member_settings', 'mail_outbox']) {
      await t.db.unsafe(`delete from ${table}`)
    }
    resetMemberLimits()
    resetPublicOrigins()
    await saveMemberSettings(t.db, { ...DEFAULT_MEMBER_SETTINGS, signupMode: 'open', pages: await publishMemberPages(t.db, PAGES) })
    browser = new Browser(t.db)
  })

  afterEach(async () => {
    await flushMemberMail()
    resetPublicOrigins()
    await t.cleanup()
  })

  /** The newest captured email of a kind, and the token in its link. */
  async function lastMail(kind: string, to?: string): Promise<{ body: string; token: string } | null> {
    await flushMemberMail()
    const { rows } = await t.db<{ body_text: string; to_address: string }>`
      select body_text, to_address from mail_outbox
       where kind = ${`member.${kind}`}
       order by created_at desc, id desc
    `
    const row = to ? rows.find((r) => r.to_address === to) : rows[0]
    if (!row) return null
    const match = row.body_text.match(/token=([A-Za-z0-9_-]+)/)
    return { body: row.body_text, token: match?.[1] ?? '' }
  }

  async function mailCount(kind: string): Promise<number> {
    await flushMemberMail()
    const { rows } = await t.db<{ n: number }>`
      select count(*) as n from mail_outbox where kind = ${`member.${kind}`}
    `
    return Number(rows[0].n)
  }

  /** Sign up and confirm in `who`'s browser; leaves it signed in. */
  async function register(who: Browser, email: string, password = PASSWORD): Promise<void> {
    expect((await who.post('signup', { email, password })).status).toBe(200)
    const mail = await lastMail('verify', email)
    expect((await who.post('verify', { token: mail!.token })).status).toBe(200)
  }

  describe('sign-up', () => {
    it('is closed until the owner opens it', async () => {
      await saveMemberSettings(t.db, DEFAULT_MEMBER_SETTINGS)
      const res = await browser.post('signup', { email: 'a@example.com', password: PASSWORD })
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe('signup_closed')
      expect(await findMemberByEmail(t.db, 'a@example.com')).toBeNull()
    })

    it('creates no session and no usable password until the address is confirmed', async () => {
      const res = await browser.post('signup', { email: 'New@Example.com', password: PASSWORD, name: 'Ada' })
      expect(await res.json()).toEqual({ ok: true, code: 'check_email' })
      expect(await browser.me()).toBeNull()

      const pending = await findMemberByEmail(t.db, 'new@example.com')
      expect(pending).toMatchObject({ emailVerifiedAt: null, passwordHash: null })
      const early = await browser.post('login', { email: 'new@example.com', password: PASSWORD })
      expect(await errorCode(early)).toBe('invalid_credentials')

      const mail = await lastMail('verify')
      expect(mail!.body).toContain(`${ORIGIN}/welcome?token=`)
      const confirmed = await browser.post('verify', { token: mail!.token })
      expect(confirmed.status).toBe(200)
      expect(await browser.me()).toMatchObject({
        email: 'New@Example.com',
        emailVerified: true,
        hasPassword: true,
        profile: { name: 'Ada' },
      })

      const second = new Browser(t.db)
      expect((await second.post('login', { email: 'NEW@example.com', password: PASSWORD })).status).toBe(200)
    })

    it('answers the same for a new address and one that already has an account', async () => {
      await register(browser, 'taken@example.com')
      const stranger = new Browser(t.db)
      const fresh = await stranger.post('signup', { email: 'fresh@example.com', password: PASSWORD })
      const taken = await stranger.post('signup', { email: 'taken@example.com', password: OTHER_PASSWORD })
      expect(taken.status).toBe(fresh.status)
      expect(await taken.text()).toBe(await fresh.text())

      // The owner of the address is told; the existing password is untouched.
      expect(await mailCount('already_registered')).toBe(1)
      const again = new Browser(t.db)
      expect((await again.post('login', { email: 'taken@example.com', password: PASSWORD })).status).toBe(200)
      expect((await again.post('login', { email: 'taken@example.com', password: OTHER_PASSWORD })).status).toBe(401)
    })

    it('never applies an attacker’s password when they signed up first', async () => {
      const attacker = new Browser(t.db)
      const victim = new Browser(t.db)
      await attacker.post('signup', { email: 'v@example.com', password: OTHER_PASSWORD })
      await victim.post('signup', { email: 'v@example.com', password: PASSWORD })

      const mail = await lastMail('verify', 'v@example.com')
      await victim.post('verify', { token: mail!.token })
      expect(await victim.me()).toMatchObject({ hasPassword: true })

      expect((await new Browser(t.db).post('login', { email: 'v@example.com', password: PASSWORD })).status).toBe(200)
      expect((await attacker.post('login', { email: 'v@example.com', password: OTHER_PASSWORD })).status).toBe(401)
    })

    it('throws away a stranger’s password when the address owner opens their link', async () => {
      const attacker = new Browser(t.db)
      const victim = new Browser(t.db)
      await attacker.post('signup', { email: 'v@example.com', password: OTHER_PASSWORD })
      const mail = await lastMail('verify', 'v@example.com')

      // The owner of the address never signed up; they just open the email.
      expect((await victim.post('verify', { token: mail!.token })).status).toBe(200)
      expect(await victim.me()).toMatchObject({ emailVerified: true, hasPassword: false })
      expect((await attacker.post('login', { email: 'v@example.com', password: OTHER_PASSWORD })).status).toBe(401)

      // Passwordless and just signed in: they can set their own password.
      const set = await victim.post('password/change', { newPassword: PASSWORD })
      expect(set.status).toBe(200)
      expect((await new Browser(t.db).post('login', { email: 'v@example.com', password: PASSWORD })).status).toBe(200)
    })

    it('never applies an attacker’s password when they signed up second', async () => {
      const attacker = new Browser(t.db)
      const victim = new Browser(t.db)
      await victim.post('signup', { email: 'v@example.com', password: PASSWORD })
      const firstLink = await lastMail('verify', 'v@example.com')
      await attacker.post('signup', { email: 'v@example.com', password: OTHER_PASSWORD })
      const secondLink = await lastMail('verify', 'v@example.com')

      // Only the newest link works, and it carries the attacker's password.
      expect(await errorCode(await victim.post('verify', { token: firstLink!.token }))).toBe('invalid_token')
      await victim.post('verify', { token: secondLink!.token })
      // The victim is in, with no password set at all.
      expect(await victim.me()).toMatchObject({ emailVerified: true, hasPassword: false })
      expect((await attacker.post('login', { email: 'v@example.com', password: OTHER_PASSWORD })).status).toBe(401)
    })

    it('rejects a short password and a required profile field left empty', async () => {
      const weak = await browser.post('signup', { email: 'a@example.com', password: 'short' })
      expect(((await weak.json()) as ErrorBody).error).toMatchObject({ code: 'weak_password', field: 'password' })

      await saveMemberSettings(t.db, {
        signupMode: 'open',
        pages: await publishMemberPages(t.db, PAGES),
        profileFields: [{ id: 'company', label: 'Company', type: 'text', required: true }],
      })
      const missing = await browser.post('signup', { email: 'a@example.com', password: PASSWORD })
      expect(((await missing.json()) as ErrorBody).error).toMatchObject({ code: 'invalid_input', field: 'company' })
    })
  })

  describe('sign-in', () => {
    it('answers the same for a wrong password and an unknown address', async () => {
      await register(browser, 'm@example.com')
      const stranger = new Browser(t.db)
      const wrong = await stranger.post('login', { email: 'm@example.com', password: 'wrong-password-1' })
      const unknown = await stranger.post('login', { email: 'nobody@example.com', password: 'wrong-password-1' })
      expect(wrong.status).toBe(401)
      expect(unknown.status).toBe(401)
      expect(await wrong.text()).toBe(await unknown.text())
    })

    it('sets an HttpOnly, SameSite=Lax cookie on the whole site', async () => {
      await register(browser, 'm@example.com')
      const res = await new Browser(t.db).post('login', { email: 'm@example.com', password: PASSWORD })
      const cookie = res.headers.getSetCookie().find((line) => line.startsWith('instatic_member='))
      expect(cookie).toContain('Path=/;')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('uses a __Host- Secure cookie on an https site and ignores the plain name there', async () => {
      await register(browser, 'm@example.com')
      const plainCookie = browser.cookie
      configurePublicOrigins(['https://example.com'])
      const secure = new Browser(t.db)
      const res = await secure.post(
        'login',
        { email: 'm@example.com', password: PASSWORD },
        { base: 'https://example.com' },
      )
      const cookie = res.headers.getSetCookie().find((line) => line.startsWith('__Host-instatic_member='))
      expect(cookie).toContain('Secure')
      expect(cookie).not.toContain('Domain=')

      const url = new URL('/_instatic/members/me', 'https://example.com')
      const withPlain = await handleMemberRequest(requestWithCookie(url, plainCookie), t.db, url)
      expect(((await withPlain.json()) as { member: unknown }).member).toBeNull()
    })

    it('slows repeated wrong passwords without locking the account', async () => {
      await register(browser, 'm@example.com')
      const guesser = new Browser(t.db)
      for (let i = 0; i < 5; i++) {
        expect((await guesser.post('login', { email: 'm@example.com', password: `wrong-guess-${i}00` })).status).toBe(401)
      }
      const blocked = await guesser.post('login', { email: 'm@example.com', password: PASSWORD })
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBeTruthy()

      // The member's own sign-in link still works: nobody was locked out.
      await new Browser(t.db).post('link/request', { email: 'm@example.com' })
      const link = await lastMail('magic')
      expect((await new Browser(t.db).post('link/confirm', { token: link!.token })).status).toBe(200)
    })

    it('lets the owner in with the right password after a stranger ran the email’s limit out', async () => {
      await register(browser, 'm@example.com')
      const from = (ip: string, password: string) =>
        new Browser(t.db).post('login', { email: 'm@example.com', password }, { headers: { 'x-bun-socket-ip': ip } })

      // 20 wrong guesses from 20 addresses use up the per-email allowance.
      for (let i = 1; i <= 20; i++) expect((await from(`203.0.113.${i}`, `wrong-guess-${i}00`)).status).toBe(401)
      // Those addresses are now refused outright, even with the right password.
      expect((await from('203.0.113.1', PASSWORD)).status).toBe(429)
      // The owner, from an address that never tried, still gets in.
      expect((await from('198.51.100.7', PASSWORD)).status).toBe(200)
    })

    it('caps what a guesser with many addresses gains, and leaves the owner the emailed link', async () => {
      await register(browser, 'm@example.com')
      const from = (ip: string, password: string) =>
        new Browser(t.db).post('login', { email: 'm@example.com', password }, { headers: { 'x-bun-socket-ip': ip } })

      for (let i = 1; i <= 20; i++) await from(`203.0.113.${i}`, `wrong-guess-${i}00`)
      // Five further tries from new addresses, then nothing more for anyone.
      for (let i = 21; i <= 25; i++) expect((await from(`203.0.113.${i}`, `wrong-guess-${i}00`)).status).toBe(401)
      expect((await from('203.0.113.26', 'wrong-guess-2600')).status).toBe(429)
      expect((await from('198.51.100.7', PASSWORD)).status).toBe(429)

      // The password is closed for now; the sign-in link is not.
      await new Browser(t.db).post('link/request', { email: 'm@example.com' })
      const link = await lastMail('magic')
      expect((await new Browser(t.db).post('link/confirm', { token: link!.token })).status).toBe(200)
    })

    it('reserves an attempt before checking the password, so a burst cannot slip under the limit', async () => {
      await register(browser, 'm@example.com')
      const burst = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          new Browser(t.db).post('login', { email: 'm@example.com', password: `wrong-guess-${i}00` }),
        ),
      )
      const statuses = burst.map((res) => res.status)
      expect(statuses.filter((status) => status === 401)).toHaveLength(5)
      expect(statuses.filter((status) => status === 429)).toHaveLength(7)
    })

    it('reads the sign-up marker only from its own cookie, and not when it appears twice', async () => {
      const attacker = new Browser(t.db)
      await attacker.post('signup', { email: 'v@example.com', password: OTHER_PASSWORD })
      const attackerMarker = attacker.cookie.split('; ').find((c) => c.startsWith('instatic_member_signup='))!
      const mail = await lastMail('verify', 'v@example.com')

      // A planted second copy of the marker beside the victim's own: refused.
      const res = await new Browser(t.db).post(
        'verify',
        { token: mail!.token },
        { cookie: `${attackerMarker}; instatic_member_signup=${crypto.randomUUID()}` },
      )
      expect(res.status).toBe(200)
      const member = await findMemberByEmail(t.db, 'v@example.com')
      expect(member).toMatchObject({ passwordHash: null })
    })

    it('uses a __Host- sign-up marker on an https site', async () => {
      configurePublicOrigins(['https://example.com'])
      const res = await new Browser(t.db).post(
        'signup',
        { email: 'a@example.com', password: PASSWORD },
        { base: 'https://example.com' },
      )
      const marker = res.headers.getSetCookie().find((line) => line.includes('instatic_member_signup='))
      expect(marker).toStartWith('__Host-instatic_member_signup=')
      expect(marker).toContain('Path=/;')
      expect(marker).toContain('Secure')
    })

    it('signs out for real: the old cookie stops working', async () => {
      await register(browser, 'm@example.com')
      const stolen = browser.cookie
      expect(await browser.me()).not.toBeNull()
      await browser.post('logout', {})
      expect(await browser.me()).toBeNull()

      const url = new URL('/_instatic/members/me', ORIGIN)
      const replay = await handleMemberRequest(requestWithCookie(url, stolen), t.db, url)
      expect(((await replay.json()) as { member: unknown }).member).toBeNull()
    })

    it('ends every session the moment a member is suspended', async () => {
      await register(browser, 'm@example.com')
      await t.db`update members set status = 'suspended' where email_normalized = 'm@example.com'`
      expect(await browser.me()).toBeNull()
      const res = await new Browser(t.db).post('login', { email: 'm@example.com', password: PASSWORD })
      expect(res.status).toBe(401)
    })

    it('expires a session that has been idle for more than 30 days', async () => {
      await register(browser, 'm@example.com')
      const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
      await t.db`update member_sessions set last_seen_at = ${stale}`
      expect(await browser.me()).toBeNull()
    })
  })

  describe('links by email', () => {
    it('answers the same for a reset request whether or not the address exists', async () => {
      await register(browser, 'm@example.com')
      const stranger = new Browser(t.db)
      const known = await stranger.post('password/forgot', { email: 'm@example.com' })
      const unknown = await stranger.post('password/forgot', { email: 'nobody@example.com' })
      expect(await known.text()).toBe(await unknown.text())
      expect(await mailCount('reset')).toBe(1)
    })

    it('resets a password once, ends old sessions and keeps the link on a weak password', async () => {
      await register(browser, 'm@example.com')
      const oldSession = browser.cookie
      const other = new Browser(t.db)
      await other.post('password/forgot', { email: 'm@example.com' })
      const mail = await lastMail('reset')

      const weak = await other.post('password/reset', { token: mail!.token, password: 'short' })
      expect(await errorCode(weak)).toBe('weak_password')

      const ok = await other.post('password/reset', { token: mail!.token, password: 'a-brand-new-password' })
      expect(ok.status).toBe(200)
      expect(await other.me()).not.toBeNull()

      const replay = await new Browser(t.db).post('password/reset', { token: mail!.token, password: 'yet-another-password' })
      expect(await errorCode(replay)).toBe('invalid_token')

      const url = new URL('/_instatic/members/me', ORIGIN)
      const old = await handleMemberRequest(requestWithCookie(url, oldSession), t.db, url)
      expect(((await old.json()) as { member: unknown }).member).toBeNull()
      expect((await new Browser(t.db).post('login', { email: 'm@example.com', password: PASSWORD })).status).toBe(401)
      expect(await mailCount('password_changed')).toBe(1)
    })

    it('refuses an expired sign-in link and a token of another kind', async () => {
      await register(browser, 'm@example.com')
      const member = await findMemberByEmail(t.db, 'm@example.com')
      const expired = await issueMemberToken(t.db, member!.id, 'magic', {}, Date.now() - 16 * 60 * 1000)
      expect(await errorCode(await new Browser(t.db).post('link/confirm', { token: expired.token }))).toBe('invalid_token')

      const reset = await issueMemberToken(t.db, member!.id, 'reset')
      expect(await errorCode(await new Browser(t.db).post('link/confirm', { token: reset.token }))).toBe('invalid_token')
    })

    it('still delivers a sign-in link after a stranger used up the reset emails', async () => {
      await register(browser, 'm@example.com')
      // Remote callers only get links when the site's public origin is configured.
      configurePublicOrigins([ORIGIN])
      for (let i = 0; i < 6; i++) {
        await new Browser(t.db).post('password/forgot', { email: 'm@example.com' }, {
          headers: { 'x-bun-socket-ip': `203.0.113.${i + 1}` },
        })
      }
      expect(await mailCount('reset')).toBe(4)
      // The newest reset link is still valid, and other kinds still arrive.
      const reset = await lastMail('reset')
      await new Browser(t.db).post('link/request', { email: 'm@example.com' })
      expect(await mailCount('magic')).toBe(1)
      // Across every kind, one inbox gets at most eight an hour.
      for (let i = 0; i < 8; i++) {
        await new Browser(t.db).post('link/request', { email: 'm@example.com' }, {
          headers: { 'x-bun-socket-ip': `198.51.100.${i + 1}` },
        })
      }
      expect((await mailCount('reset')) + (await mailCount('magic')) + (await mailCount('verify'))).toBeLessThanOrEqual(8)
      const ok = await new Browser(t.db).post('password/reset', { token: reset!.token, password: 'a-brand-new-password' })
      expect(ok.status).toBe(200)
    })

    it('does not mail one recipient more than a few times an hour', async () => {
      await register(browser, 'm@example.com')
      for (let i = 0; i < 8; i++) {
        const res = await new Browser(t.db).post(
          'password/forgot',
          { email: 'm@example.com' },
          { headers: { 'x-bun-socket-ip': '127.0.0.1' } },
        )
        expect([200, 429]).toContain(res.status)
      }
      expect(await mailCount('reset')).toBeLessThanOrEqual(4)
    })

    it('serves no page of its own for a link or for signing in', async () => {
      await register(browser, 'm@example.com')
      await new Browser(t.db).post('password/forgot', { email: 'm@example.com' })
      const mail = await lastMail('reset')
      expect(mail!.body).toContain(`${ORIGIN}/new-password?token=`)
      for (const path of [`link/reset?token=${mail!.token}`, 'link/verify', 'sign-in', 'sign-in?next=%2Faccount']) {
        expect((await browser.get(path)).status).toBe(404)
      }
      // Asking for those addresses used nothing up.
      const ok = await new Browser(t.db).post('password/reset', { token: mail!.token, password: 'a-brand-new-password' })
      expect(ok.status).toBe(200)
    })

    it('switches a feature off, for every address alike, while its page is not set', async () => {
      await register(browser, 'm@example.com')
      await saveMemberSettings(t.db, { ...DEFAULT_MEMBER_SETTINGS, signupMode: 'open', pages: {} })
      const visitor = new Browser(t.db)
      for (const [action, body] of [
        ['signup', { email: 'new@example.com', password: PASSWORD }],
        ['password/forgot', { email: 'm@example.com' }],
        ['password/forgot', { email: 'nobody@example.com' }],
        ['link/request', { email: 'm@example.com' }],
      ] as const) {
        const res = await visitor.post(action, body)
        expect(res.status).toBe(404)
        expect(await errorCode(res)).toBe('not_available')
      }
      const change = await browser.post('email/change', { email: 'next@example.com', currentPassword: PASSWORD })
      expect(await errorCode(change)).toBe('not_available')
      expect(await findMemberByEmail(t.db, 'new@example.com')).toBeNull()
      expect((await mailCount('reset')) + (await mailCount('magic')) + (await mailCount('email_change'))).toBe(0)
      // Signing in with a password needs no emailed link, so it still works.
      expect((await visitor.post('login', { email: 'm@example.com', password: PASSWORD })).status).toBe(200)
    })
  })

  describe('where links point', () => {
    it('builds links from the configured public origin, not the Host header', async () => {
      configurePublicOrigins(['https://real.example'])
      const res = await browser.post(
        'signup',
        { email: 'a@example.com', password: PASSWORD },
        { base: 'https://real.example', headers: { host: 'evil.example' } },
      )
      expect(res.status).toBe(200)
      const mail = await lastMail('verify')
      expect(mail!.body).toContain('https://real.example/welcome?token=')
      expect(mail!.body).not.toContain('evil.example')
    })

    it('sends no links at all from a public host with no configured origin', async () => {
      const res = await browser.post(
        'signup',
        { email: 'a@example.com', password: PASSWORD },
        { base: 'http://evil.example' },
      )
      expect(res.status).toBe(503)
      expect(await errorCode(res)).toBe('email_unavailable')
      expect(await mailCount('verify')).toBe(0)
    })

    it('does not trust "Host: localhost" from a remote peer', async () => {
      const url = new URL('/_instatic/members/signup', ORIGIN)
      const req = new Request(url, {
        method: 'POST',
        body: JSON.stringify({ email: 'a@example.com', password: PASSWORD }),
      })
      req.headers.set('origin', ORIGIN)
      req.headers.set('content-type', 'application/json')
      stampSocketIp(req, '203.0.113.9')
      const res = await handleMemberRequest(req, t.db, url)
      expect(await errorCode(res)).toBe('email_unavailable')
    })

    it('sends links to the page the owner assigned', async () => {
      await saveMemberSettings(t.db, {
        ...DEFAULT_MEMBER_SETTINGS,
        signupMode: 'open',
        pages: await publishMemberPages(t.db, { verify: '/thanks' }),
      })
      await browser.post('signup', { email: 'a@example.com', password: PASSWORD })
      expect((await lastMail('verify'))!.body).toContain(`${ORIGIN}/thanks?token=`)
    })
  })

  describe('sign-out form', () => {
    it('signs out from a plain form post and lands on the page the form names', async () => {
      await register(browser, 'm@example.com')
      const res = await browser.post('logout', { _success: '/bye' }, { json: false })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/bye')
      expect(await browser.me()).toBeNull()
    })

    it('returns to the page the form is on when it names no other', async () => {
      await register(browser, 'm@example.com')
      const res = await browser.post('logout', {}, { json: false, headers: { referer: `${ORIGIN}/account` } })
      expect(res.headers.get('location')).toBe('/account?member_ok=signed_out')
      expect(await browser.me()).toBeNull()
    })

    it('has no address that signs a member out by opening it', async () => {
      await register(browser, 'm@example.com')
      const res = await browser.get('logout', { 'sec-fetch-site': 'same-origin' })
      expect(res.status).toBe(404)
      expect(await browser.me()).not.toBeNull()
    })
  })

  describe('cross-site requests', () => {
    it('refuses a POST with no Origin, a foreign Origin, or a cross-site fetch', async () => {
      await register(browser, 'm@example.com')
      const noOrigin = await browser.post('logout', {}, { origin: null })
      const foreign = await browser.post('logout', {}, { origin: 'https://evil.example' })
      const crossSite = await browser.post('logout', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
      for (const res of [noOrigin, foreign, crossSite]) {
        expect(res.status).toBe(403)
        expect(await errorCode(res)).toBe('forbidden_origin')
      }
      expect(await browser.me()).not.toBeNull()
    })
  })

  describe('plain HTML forms', () => {
    it('redirects to the page the form named on success', async () => {
      await register(browser, 'm@example.com')
      const visitor = new Browser(t.db)
      const res = await visitor.post(
        'login',
        { email: 'm@example.com', password: PASSWORD, _success: '/account' },
        { json: false },
      )
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/account')
      expect(await visitor.me()).not.toBeNull()
    })

    it('returns to the form with an error code and the field at fault', async () => {
      const res = await browser.post(
        'signup',
        { email: 'a@example.com', password: 'short' },
        { json: false, headers: { referer: `${ORIGIN}/join?plan=pro` } },
      )
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/join?plan=pro&member_error=weak_password&member_field=password')
    })

    it('sends a member who just signed in to the owner\'s "after signing in" page when nothing else says where', async () => {
      await register(browser, 'm@example.com')
      await saveMemberSettings(t.db, { ...DEFAULT_MEMBER_SETTINGS, signupMode: 'open', pages: await publishMemberPages(t.db, { ...PAGES, afterLogin: '/account' }) })

      // A script-driven form is told the page and decides itself (`?next=` and the form's own redirect come first).
      const json = await new Browser(t.db).post('login', { email: 'm@example.com', password: PASSWORD })
      expect(await json.json()).toMatchObject({ ok: true, code: 'signed_in', landing: '/account' })
      // An action that signs nobody in names no page.
      expect(await (await browser.post('profile', { name: 'M' })).json()).not.toHaveProperty('landing')

      // A plain form with no redirect of its own is sent there.
      const plain = await new Browser(t.db).post('login', { email: 'm@example.com', password: PASSWORD }, { json: false })
      expect(plain.status).toBe(303)
      expect(plain.headers.get('location')).toBe('/account')
      // The form's own choice still wins.
      const chosen = await new Browser(t.db).post('login', { email: 'm@example.com', password: PASSWORD, _success: '/hello' }, { json: false })
      expect(chosen.headers.get('location')).toBe('/hello')
    })

    it('never redirects off the site', async () => {
      await register(browser, 'm@example.com')
      for (const target of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
        const res = await new Browser(t.db).post(
          'login',
          { email: 'm@example.com', password: PASSWORD, _success: target },
          { json: false, headers: { referer: 'https://evil.example/page' } },
        )
        expect(res.headers.get('location')).toBe('/?member_ok=signed_in')
      }
    })

    it('accepts only site-relative redirect paths', () => {
      expect(safeRedirectPath('/account?tab=1#top')).toBe('/account?tab=1#top')
      for (const bad of ['', 'account', '//x.example', '/\\x.example', 'https://x.example', '/a\nb', '/a\\b', '/.//x.example', '/%2e//x.example']) {
        expect(safeRedirectPath(bad)).toBeNull()
      }
    })
  })

  describe('account changes', () => {
    it('changes a password only with the current one, and ends other sessions', async () => {
      await register(browser, 'm@example.com')
      const elsewhere = new Browser(t.db)
      await elsewhere.post('login', { email: 'm@example.com', password: PASSWORD })
      const beforeChange = browser.cookie

      const wrong = await browser.post('password/change', { currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' })
      expect(((await wrong.json()) as ErrorBody).error).toMatchObject({ code: 'invalid_credentials', field: 'currentPassword' })

      const ok = await browser.post('password/change', { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' })
      expect(ok.status).toBe(200)
      expect(browser.cookie).not.toBe(beforeChange)
      expect(await browser.me()).not.toBeNull()
      expect(await elsewhere.me()).toBeNull()
    })

    it('needs a signed-in member', async () => {
      for (const action of ['password/change', 'email/change', 'profile', 'delete']) {
        const res = await browser.post(action, {})
        expect(res.status).toBe(401)
        expect(await errorCode(res)).toBe('not_signed_in')
      }
      expect((await browser.get('export')).status).toBe(401)
    })

    it('moves the account to a new address only after that address confirms', async () => {
      await register(browser, 'old@example.com')
      const res = await browser.post('email/change', { email: 'new@example.com', currentPassword: PASSWORD })
      expect(res.status).toBe(200)
      expect((await browser.me())!.email).toBe('old@example.com')
      expect(await mailCount('email_change_notice')).toBe(1)

      const mail = await lastMail('email_change', 'new@example.com')
      await new Browser(t.db).post('email/confirm', { token: mail!.token })
      expect(await findMemberByEmail(t.db, 'old@example.com')).toBeNull()
      expect((await new Browser(t.db).post('login', { email: 'new@example.com', password: PASSWORD })).status).toBe(200)
      // The session from before the change was ended.
      expect(await browser.me()).toBeNull()
    })

    it('does not reveal that a requested new address belongs to someone else', async () => {
      await register(new Browser(t.db), 'taken@example.com')
      await register(browser, 'me@example.com')
      const res = await browser.post('email/change', { email: 'taken@example.com', currentPassword: PASSWORD })
      expect(await res.json()).toEqual({ ok: true, code: 'check_email' })
      expect(await mailCount('email_change')).toBe(0)
    })

    it('updates only the profile fields the owner defined', async () => {
      await register(browser, 'm@example.com')
      const res = await browser.post('profile', { name: 'Grace', role: 'admin', email: 'x@example.com' })
      expect(res.status).toBe(200)
      const me = await browser.me()
      expect(me!.profile).toEqual({ name: 'Grace' })
      expect(me!.email).toBe('m@example.com')
    })

    it('exports the member’s own data', async () => {
      await register(browser, 'm@example.com')
      const res = await browser.get('export')
      expect(res.headers.get('content-disposition')).toContain('attachment')
      const data = (await res.json()) as { account: { email: string }; activity: Array<{ kind: string }> }
      expect(data.account.email).toBe('m@example.com')
      expect(data.activity.map((event) => event.kind)).toContain('signup')
      expect(JSON.stringify(data)).not.toContain('argon2')
    })

    it('deletes by anonymising, and frees the address', async () => {
      await register(browser, 'm@example.com')
      const member = await findMemberByEmail(t.db, 'm@example.com')
      const denied = await browser.post('delete', { currentPassword: 'not-the-password' })
      expect(denied.status).toBe(401)

      expect((await browser.post('delete', { currentPassword: PASSWORD })).status).toBe(200)
      expect(await browser.me()).toBeNull()
      const { rows } = await t.db<{ email: string; status: string; password_hash: string | null }>`
        select email, status, password_hash from members where id = ${member!.id}
      `
      expect(rows[0]).toEqual({ email: `deleted+${member!.id}@invalid`, status: 'deleted', password_hash: null })
      const sessions = await t.db`select id_hash from member_sessions where member_id = ${member!.id}`
      expect(sessions.rows).toEqual([])

      await register(new Browser(t.db), 'm@example.com')
      expect((await findMemberByEmail(t.db, 'm@example.com'))!.id).not.toBe(member!.id)
    })
  })

  describe('tags', () => {
    it('keeps a tag while any source still grants it, and drops expired grants', async () => {
      await register(browser, 'm@example.com')
      const { id } = (await findMemberByEmail(t.db, 'm@example.com'))!
      await grantMemberTag(t.db, { memberId: id, tag: 'pro', source: 'admin', expiresAt: null })
      await grantMemberTag(t.db, { memberId: id, tag: 'pro', source: 'plugin:shop', expiresAt: null })
      await grantMemberTag(t.db, {
        memberId: id,
        tag: 'trial',
        source: 'admin',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      expect(await listActiveMemberTags(t.db, id)).toEqual(['pro'])

      await revokeMemberTag(t.db, { memberId: id, tag: 'pro', source: 'plugin:shop' })
      expect((await browser.me())!.tags).toEqual(['pro'])
      await revokeMemberTag(t.db, { memberId: id, tag: 'pro', source: 'admin' })
      expect((await browser.me())!.tags).toEqual([])
    })
  })
  // The admin's view of members. These call the queries directly so they run
  // on Postgres too (`DB=postgres`); the HTTP side is in membersAdmin.test.ts.
  describe('admin queries', () => {
    const make = async (email: string, name: string, passwordHash: string | null = 'x') =>
      (await createMember(t.db, { email, passwordHash, profile: name ? { name } : {}, verified: passwordHash !== null }))!

    it('lists, searches, filters and counts the same on both databases', async () => {
      const ada = await make('ada@example.com', 'Ada Lovelace')
      await make('grace@example.com', 'Grace Hopper')
      await make('pending@example.com', '', null)
      const linus = await make('linus@example.com', '')
      await grantMemberTag(t.db, { memberId: ada.id, tag: 'pro', source: 'admin', expiresAt: null })
      await grantMemberTag(t.db, { memberId: ada.id, tag: 'pro', source: 'acme.shop', expiresAt: null })
      await grantMemberTag(t.db, { memberId: linus.id, tag: 'old', source: 'admin', expiresAt: new Date(Date.now() - 1000).toISOString() })
      await setMemberSuspended(t.db, linus.id, true)

      const all = await listMembersForAdmin(t.db)
      expect(all.counts).toEqual({ all: 4, active: 2, pending: 1, suspended: 1 })
      expect(all.matching).toBe(4)
      expect(all.nextOffset).toBeNull()
      // One member holding a tag from two sources is one member.
      expect(all.tags).toEqual([{ tag: 'pro', count: 1 }])

      expect((await listMembersForAdmin(t.db, { search: 'LOVELACE' })).members.map((m) => m.email)).toEqual(['ada@example.com'])
      expect((await listMembersForAdmin(t.db, { search: 'grace@' })).members.map((m) => m.email)).toEqual(['grace@example.com'])
      expect((await listMembersForAdmin(t.db, { search: '%' })).matching).toBe(4)
      expect((await listMembersForAdmin(t.db, { status: 'pending' })).members.map((m) => m.email)).toEqual(['pending@example.com'])
      expect((await listMembersForAdmin(t.db, { status: 'suspended' })).members.map((m) => m.email)).toEqual(['linus@example.com'])
      expect((await listMembersForAdmin(t.db, { tag: 'pro', search: 'ada' })).members[0]).toMatchObject({
        name: 'Ada Lovelace', status: 'active', tags: ['pro'],
      })
      expect((await listMembersForAdmin(t.db, { tag: 'old' })).matching).toBe(0)

      const detail = await getMemberForAdmin(t.db, ada.id)
      expect(detail?.grants.map((grant) => grant.source).sort()).toEqual(['acme.shop', 'admin'])
      expect(detail?.events).toEqual([])
    })

    it('pages through more members than one page holds', async () => {
      for (let index = 0; index < 55; index += 1) await make(`m${String(index).padStart(2, '0')}@example.com`, '')
      const first = await listMembersForAdmin(t.db)
      expect(first.members).toHaveLength(50)
      expect(first.nextOffset).toBe(50)
      const second = await listMembersForAdmin(t.db, { offset: first.nextOffset ?? 0 })
      expect(second.members).toHaveLength(5)
      expect(second.nextOffset).toBeNull()
      const seen = new Set([...first.members, ...second.members].map((m) => m.id))
      expect(seen.size).toBe(55)
    })

    it('does not let an invitation inherit a sign-up someone else started for the address', async () => {
      // A stranger starts a sign-up with the victim's address and never confirms it.
      const stranger = new Browser(t.db)
      await stranger.post('signup', { email: 'victim@example.com', password: 'a-long-enough-password', name: 'Mallory' })
      const before = await findMemberByEmail(t.db, 'victim@example.com')
      expect(before?.profile).toEqual({ name: 'Mallory' })
      const strangerLink = (await lastMail('verify', 'victim@example.com'))!.token

      expect(await inviteMember(t.db, { email: 'victim@example.com', tags: ['pro'], linkOrigin: 'http://localhost' })).toMatchObject({ ok: true, outcome: 'resent' })
      expect((await findMemberByEmail(t.db, 'victim@example.com'))?.profile).toEqual({})
      // The stranger's confirmation link no longer works.
      expect((await stranger.post('verify', { token: strangerLink })).status).toBe(400)
    })

    it('invites, re-invites and deletes', async () => {
      const invited = await inviteMember(t.db, { email: 'new@example.com', tags: ['student'], linkOrigin: 'http://localhost' })
      expect(invited).toMatchObject({ ok: true, outcome: 'invited' })
      expect(await inviteMember(t.db, { email: 'new@example.com', tags: [], linkOrigin: 'http://localhost' })).toMatchObject({ ok: true, outcome: 'resent' })
      const taken = await make('ada@example.com', 'Ada')
      expect(await inviteMember(t.db, { email: 'ada@example.com', tags: [], linkOrigin: 'http://localhost' })).toEqual({ ok: false, reason: 'exists' })
      expect(await mailCount('invite')).toBe(2)

      expect(await deleteMemberAsAdmin(t.db, taken.id)).toBe(true)
      expect(await deleteMemberAsAdmin(t.db, taken.id)).toBe(false)
      expect((await listMembersForAdmin(t.db)).counts.all).toBe(1)
    })
  })

})
