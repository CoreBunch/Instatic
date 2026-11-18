import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { DEFAULT_MEMBER_SETTINGS } from '@core/members'
import { resetPublicOrigins } from '../../../server/auth/security'
import { setMemberSuspended } from '../../../server/members/admin'
import { memberAppRequestFrame } from '../../../server/members/apps/approval'
import { handleMemberOAuthRequest, resetMemberAppLimits } from '../../../server/members/apps/handler'
import {
  createMemberApp,
  deleteMemberApp,
  sweepExpiredMemberAppRows,
  type MemberAppRecord,
} from '../../../server/members/apps/store'
import { handleMemberRequest } from '../../../server/members/handlers'
import { resetMemberLimits } from '../../../server/members/limits'
import { createMember, grantMemberTag, saveMemberSettings } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { pkceChallengeForVerifier } from '../../../server/oauth/secrets'
import { publishMemberPages } from '../helpers/memberPages'

const ORIGIN = 'http://localhost'
const ISSUER = `${ORIGIN}/_instatic/members`
const REGISTERED = 'http://127.0.0.1:47821/callback'
/** The port the app happens to be listening on this time. */
const LISTENING = 'http://127.0.0.1:50123/callback'
const VERIFIER = 'v'.repeat(64)

interface Tokens {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
}

describe('sign-in for apps', () => {
  let t: TestDb
  let app: MemberAppRecord
  let memberId: string
  let cookie: string

  beforeEach(async () => {
    t = await createTestDb()
    // `DB=postgres` runs share one database across tests; start each one clean.
    for (const table of [
      'member_app_tokens', 'member_app_codes', 'member_app_grants', 'member_app_requests', 'member_apps',
      'member_events', 'member_tags', 'member_sessions', 'members', 'member_settings',
    ]) {
      await t.db.unsafe(`delete from ${table}`)
    }
    resetMemberLimits()
    resetMemberAppLimits()
    resetPublicOrigins()
    await saveMemberSettings(t.db, {
      ...DEFAULT_MEMBER_SETTINGS,
      pages: await publishMemberPages(t.db, { login: '/sign-in', appSignIn: '/approve-app' }),
    })
    app = await createMemberApp(t.db, {
      name: 'Instatic Desktop',
      redirectUris: [REGISTERED],
      scopes: ['profile', 'access'],
      createdByUserId: null,
    })
    const member = await createMember(t.db, {
      email: 'ada@example.com', passwordHash: null, profile: { name: 'Ada' }, verified: true,
    })
    memberId = member!.id
    const session = await createMemberSession(t.db, memberId, { ipAddress: null, userAgent: null })
    cookie = `instatic_member=${session.token}`
  })

  afterEach(async () => {
    resetPublicOrigins()
    await t.cleanup()
  })

  function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const url = new URL(path, ORIGIN)
    const req = new Request(url, { method: init.method ?? 'GET', body: init.body })
    // Set after construction: the test DOM's Request drops `cookie` and `origin` from an init object.
    for (const [name, value] of Object.entries(init.headers ?? {})) req.headers.set(name, value)
    return handleMemberRequest(req, t.db, url)
  }

  async function authorizeUrl(overrides: Record<string, string | null> = {}): Promise<string> {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: app.id,
      redirect_uri: LISTENING,
      code_challenge: await pkceChallengeForVerifier(VERIFIER),
      code_challenge_method: 'S256',
      scope: 'profile access',
      state: 'app-state',
    })
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) params.delete(key)
      else params.set(key, value)
    }
    return `/_instatic/members/oauth/authorize?${params}`
  }

  /** Open the authorize address as the signed-in member and return the request id the approval page gets. */
  async function startRequest(overrides: Record<string, string | null> = {}): Promise<string> {
    const res = await call(await authorizeUrl(overrides), { headers: { cookie } })
    expect(res.status).toBe(302)
    // The browser keeps the marker the site set, like a cookie jar.
    const marker = /instatic_member_app=([A-Za-z0-9-]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
    if (marker && !cookie.includes('instatic_member_app=')) cookie = `${cookie}; instatic_member_app=${marker}`
    const location = new URL(res.headers.get('location')!, ORIGIN)
    expect(location.pathname).toBe('/approve-app')
    return location.searchParams.get('request')!
  }

  /** Press Allow or Cancel on the approval page: the button carries the decision. */
  function answer(action: 'approve' | 'deny', request: string, headers: Record<string, string> = {}): Promise<Response> {
    return call('/_instatic/members/apps/approve', {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ request, decision: action === 'approve' ? 'allow' : 'deny' }),
    })
  }

  async function approvedCode(): Promise<string> {
    const res = await answer('approve', await startRequest())
    expect(res.status).toBe(200)
    const redirect = new URL(((await res.json()) as { appRedirect: string }).appRedirect)
    return redirect.searchParams.get('code')!
  }

  function tokenRequest(fields: Record<string, string>): Promise<Response> {
    return call('/_instatic/members/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.id, resource: ISSUER, ...fields }).toString(),
    })
  }

  async function signIn(): Promise<Tokens> {
    const res = await tokenRequest({
      grant_type: 'authorization_code', code: await approvedCode(), redirect_uri: LISTENING, code_verifier: VERIFIER,
    })
    expect(res.status).toBe(200)
    return (await res.json()) as Tokens
  }

  function userinfo(accessToken: string): Promise<Response> {
    return call('/_instatic/members/oauth/userinfo', { headers: { authorization: `Bearer ${accessToken}` } })
  }

  describe('the authorize address', () => {
    it('sends a signed-in member to the approval page with a stored request', async () => {
      expect(await startRequest()).toMatch(/^imem_rq_/)
    })

    it('sends a signed-out visitor through the sign-in page first', async () => {
      const res = await call(await authorizeUrl())
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!, ORIGIN)
      expect(location.pathname).toBe('/sign-in')
      expect(location.searchParams.get('next')).toMatch(/^\/approve-app\?request=imem_rq_/)
    })

    it('answers in the browser, not at the app, when the app or its address is not registered', async () => {
      const unknownApp = await call(await authorizeUrl({ client_id: 'imem_app_nope' }), { headers: { cookie } })
      const otherHost = await call(await authorizeUrl({ redirect_uri: 'https://evil.example/callback' }), { headers: { cookie } })
      const otherPath = await call(await authorizeUrl({ redirect_uri: 'http://127.0.0.1:50123/other' }), { headers: { cookie } })
      for (const res of [unknownApp, otherHost, otherPath]) {
        expect(res.status).toBe(400)
        expect(res.headers.get('location')).toBeNull()
      }
    })

    it('tells the app what was wrong with an otherwise addressed request', async () => {
      const cases: Array<[Record<string, string | null>, string]> = [
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ code_challenge: 'short' }, 'invalid_request'],
        [{ scope: 'profile billing' }, 'invalid_scope'],
        [{ scope: null }, 'invalid_scope'],
        [{ resource: 'https://other.example/' }, 'invalid_target'],
      ]
      for (const [overrides, error] of cases) {
        const res = await call(await authorizeUrl(overrides), { headers: { cookie } })
        expect(res.status).toBe(302)
        const location = new URL(res.headers.get('location')!)
        expect(`${location.origin}${location.pathname}`).toBe(LISTENING)
        expect(location.searchParams.get('error')).toBe(error)
        expect(location.searchParams.get('state')).toBe('app-state')
        expect(location.searchParams.get('iss')).toBe(ISSUER)
      }
    })

    it('refuses a scope the app was not registered for', async () => {
      const narrow = await createMemberApp(t.db, {
        name: 'Profile only', redirectUris: [REGISTERED], scopes: ['profile'], createdByUserId: null,
      })
      const res = await call(await authorizeUrl({ client_id: narrow.id }), { headers: { cookie } })
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope')
    })

    it('is off while the site has no published page for approving apps', async () => {
      await saveMemberSettings(t.db, { ...DEFAULT_MEMBER_SETTINGS, pages: {} })
      const res = await call(await authorizeUrl(), { headers: { cookie } })
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('temporarily_unavailable')
    })
  })

  describe('the member answers', () => {
    it('sends an approval back to the port the app is listening on, with a one-time code', async () => {
      const res = await answer('approve', await startRequest())
      const redirect = new URL(((await res.json()) as { appRedirect: string }).appRedirect)
      expect(`${redirect.origin}${redirect.pathname}`).toBe(LISTENING)
      expect(redirect.searchParams.get('code')).toMatch(/^imem_ac_/)
      expect(redirect.searchParams.get('state')).toBe('app-state')
      expect(redirect.searchParams.get('iss')).toBe(ISSUER)
    })

    it('answers a plain form post with a redirect to the app', async () => {
      const request = await startRequest()
      const res = await call('/_instatic/members/apps/approve', {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request, decision: 'allow' }).toString(),
      })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toStartWith(`${LISTENING}?code=imem_ac_`)
    })

    it('sends a refusal back as access_denied and signs nothing in', async () => {
      const res = await answer('deny', await startRequest())
      const redirect = new URL(((await res.json()) as { appRedirect: string }).appRedirect)
      expect(redirect.searchParams.get('error')).toBe('access_denied')
      expect(redirect.searchParams.has('code')).toBe(false)
      const { rows } = await t.db`select id from member_app_grants`
      expect(rows).toHaveLength(0)
    })

    it('never takes a post without a decision as an approval', async () => {
      const request = await startRequest()
      // What a script that does not send the pressed button would post.
      for (const body of [{ request }, { request, decision: '' }, { request, decision: 'yes' }]) {
        const res = await call('/_instatic/members/apps/approve', {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: { code: string; field?: string } }).error).toMatchObject({
          code: 'invalid_input', field: 'decision',
        })
      }
      const { rows } = await t.db`select id from member_app_grants`
      expect(rows).toHaveLength(0)
      // The request is still open for a real answer.
      expect((await answer('deny', request)).status).toBe(200)
    })

    it('takes one answer per request', async () => {
      const request = await startRequest()
      expect((await answer('approve', request)).status).toBe(200)
      expect((await answer('approve', request)).status).toBe(400)
      expect((await answer('deny', request)).status).toBe(400)
    })

    it('counts only from the browser the app opened', async () => {
      const request = await startRequest()
      const sessionOnly = cookie.split('; ').filter((part) => !part.startsWith('instatic_member_app=')).join('; ')
      const otherBrowser = await answer('approve', request, { cookie: sessionOnly })
      expect(otherBrowser.status).toBe(400)
      const wrongMarker = await answer('approve', request, { cookie: `${sessionOnly}; instatic_member_app=${'a'.repeat(32)}` })
      expect(wrongMarker.status).toBe(400)
      expect((await answer('approve', request)).status).toBe(200)
    })

    it('needs a signed-in member and a request from this site', async () => {
      const request = await startRequest()
      const signedOut = await answer('approve', request, { cookie: '' })
      expect(signedOut.status).toBe(401)
      const foreign = await answer('approve', request, { origin: 'https://evil.example' })
      expect(foreign.status).toBe(403)
      // Neither attempt used the request up.
      expect((await answer('approve', request)).status).toBe(200)
    })
  })

  describe('tokens', () => {
    it('exchanges the code once, and only with the matching verifier and address', async () => {
      const code = await approvedCode()
      const base = { grant_type: 'authorization_code', code, redirect_uri: LISTENING, code_verifier: VERIFIER }
      expect((await tokenRequest({ ...base, code_verifier: 'w'.repeat(64) })).status).toBe(400)
      expect((await tokenRequest({ ...base, redirect_uri: REGISTERED })).status).toBe(400)
      expect((await tokenRequest({ ...base, resource: 'https://other.example/' })).status).toBe(400)

      const res = await tokenRequest(base)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const tokens = (await res.json()) as Tokens
      expect(tokens.access_token).toMatch(/^imem_at_/)
      expect(tokens.refresh_token).toMatch(/^imem_rt_/)
      expect(tokens.scope).toBe('profile access')

      expect((await tokenRequest(base)).status).toBe(400)
    })

    it('rotates the refresh token and revokes the grant when an old one comes back', async () => {
      const first = await signIn()
      const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token })
      expect(rotated.status).toBe(200)
      const second = (await rotated.json()) as Tokens
      expect(second.refresh_token).not.toBe(first.refresh_token)
      expect((await userinfo(second.access_token)).status).toBe(200)

      expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).status).toBe(400)
      expect((await userinfo(second.access_token)).status).toBe(401)
      expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: second.refresh_token })).status).toBe(400)
    })

    it('is refused a client secret', async () => {
      const res = await call('/_instatic/members/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic eDp5' },
        body: 'grant_type=refresh_token',
      })
      expect(res.status).toBe(401)
    })
  })

  describe('what the app reads', () => {
    it('gives the member, their tags and when each runs out', async () => {
      const until = new Date(Date.now() + 86_400_000).toISOString()
      await grantMemberTag(t.db, { memberId, tag: 'pro', source: 'plugin:shop', expiresAt: until })
      await grantMemberTag(t.db, { memberId, tag: 'beta', source: 'admin', expiresAt: null })
      await grantMemberTag(t.db, { memberId, tag: 'old', source: 'admin', expiresAt: new Date(Date.now() - 1000).toISOString() })

      const res = await userinfo((await signIn()).access_token)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = (await res.json()) as {
        id: string; email: string; name: string; serverTime: string
        tags: Array<{ tag: string; expiresAt: string | null }>
      }
      expect(body.id).toBe(memberId)
      expect(body.email).toBe('ada@example.com')
      expect(body.name).toBe('Ada')
      expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false)
      const tags = Object.fromEntries(body.tags.map((entry) => [entry.tag, entry.expiresAt]))
      expect(Object.keys(tags).sort()).toEqual(['beta', 'pro'])
      expect(tags.beta).toBeNull()
      expect(new Date(tags.pro!).getTime()).toBe(new Date(until).getTime())
    })

    it('keeps a tag for as long as its longest grant', async () => {
      const soon = new Date(Date.now() + 60_000).toISOString()
      await grantMemberTag(t.db, { memberId, tag: 'pro', source: 'plugin:shop', expiresAt: soon })
      await grantMemberTag(t.db, { memberId, tag: 'pro', source: 'admin', expiresAt: null })
      const body = (await (await userinfo((await signIn()).access_token)).json()) as {
        tags: Array<{ tag: string; expiresAt: string | null }>
      }
      expect(body.tags).toEqual([{ tag: 'pro', expiresAt: null }])
    })

    it('leaves out what the app did not ask for', async () => {
      const code = new URL(
        ((await (await answer('approve', await startRequest({ scope: 'access' }))).json()) as { appRedirect: string }).appRedirect,
      ).searchParams.get('code')!
      const tokens = (await (await tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: LISTENING, code_verifier: VERIFIER,
      })).json()) as Tokens
      const body = (await (await userinfo(tokens.access_token)).json()) as Record<string, unknown>
      expect(body.tags).toEqual([])
      expect(body.email).toBeUndefined()
      expect(body.name).toBeUndefined()
    })

    it('answers 401 without a token, with a wrong one, and with a refresh token', async () => {
      const tokens = await signIn()
      expect((await call('/_instatic/members/oauth/userinfo')).status).toBe(401)
      expect((await userinfo('imem_at_' + 'x'.repeat(43))).status).toBe(401)
      expect((await userinfo(tokens.refresh_token)).status).toBe(401)
    })
  })

  describe('ending access', () => {
    it('signs the app out when it revokes its token', async () => {
      const tokens = await signIn()
      const res = await call('/_instatic/members/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token, client_id: app.id }).toString(),
      })
      expect(res.status).toBe(200)
      expect((await userinfo(tokens.access_token)).status).toBe(401)
      expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(400)
    })

    it('does not let another app revoke the token', async () => {
      const tokens = await signIn()
      await call('/_instatic/members/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refresh_token, client_id: 'imem_app_other' }).toString(),
      })
      expect((await userinfo(tokens.access_token)).status).toBe(200)
    })

    it('ends when the member is suspended', async () => {
      const tokens = await signIn()
      await setMemberSuspended(t.db, memberId, true)
      expect((await userinfo(tokens.access_token)).status).toBe(401)
      await setMemberSuspended(t.db, memberId, false)
      // Suspending revoked the grant; lifting it does not bring the app back.
      expect((await userinfo(tokens.access_token)).status).toBe(401)
    })

    it('ends for everyone when the owner removes the app', async () => {
      const tokens = await signIn()
      expect(await deleteMemberApp(t.db, app.id)).toBe(true)
      expect((await userinfo(tokens.access_token)).status).toBe(401)
      const res = await call(await authorizeUrl(), { headers: { cookie } })
      expect(res.status).toBe(400)
    })
  })

  it('clears out what can never be used again when a sign-in starts', async () => {
    const tokens = await signIn()
    const count = async (table: string) =>
      Number((await t.db.unsafe<{ n: number }>(`select count(*) as n from ${table}`)).rows[0]!.n)
    expect(await count('member_app_requests')).toBe(1)
    expect(await count('member_app_codes')).toBe(1)
    expect(await count('member_app_tokens')).toBe(2)

    // Two hours on: the request, the code and the access token have run out. The grant has not.
    await sweepExpiredMemberAppRows(t.db, new Date(Date.now() + 2 * 60 * 60 * 1000))
    expect(await count('member_app_requests')).toBe(0)
    expect(await count('member_app_codes')).toBe(0)
    expect(await count('member_app_tokens')).toBe(1)
    expect(await count('member_app_grants')).toBe(1)
    expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(200)

    // Past the grant's own end, nothing of it is left.
    await sweepExpiredMemberAppRows(t.db, new Date(Date.now() + 91 * 24 * 60 * 60 * 1000))
    expect(await count('member_app_grants')).toBe(0)
    expect(await count('member_app_tokens')).toBe(0)
  })

  it('withdraws the tokens of a code that is presented twice', async () => {
    const code = await approvedCode()
    const exchange = { grant_type: 'authorization_code', code, redirect_uri: LISTENING, code_verifier: VERIFIER }
    const tokens = (await (await tokenRequest(exchange)).json()) as Tokens
    expect((await userinfo(tokens.access_token)).status).toBe(200)
    expect((await tokenRequest(exchange)).status).toBe(400)
    expect((await userinfo(tokens.access_token)).status).toBe(401)
  })

  it('publishes its discovery document under the issuer path', async () => {
    const url = new URL('/.well-known/oauth-authorization-server/_instatic/members', ORIGIN)
    const res = await handleMemberOAuthRequest(new Request(url), t.db, url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.issuer).toBe(ISSUER)
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`)
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`)
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none'])
  })

  it('shows the approval page the stored app, never what the address claims', async () => {
    const request = await startRequest()
    const page = new URL(`/approve-app?request=${request}&name=Trusted+Bank`, ORIGIN)
    expect(await memberAppRequestFrame(t.db, page)).toEqual({
      name: 'Instatic Desktop',
      access: 'Your name and email address, Which memberships and access you hold',
      returnsTo: 'this device',
    })
    expect(await memberAppRequestFrame(t.db, new URL('/approve-app?request=imem_rq_unknown', ORIGIN))).toBeNull()
    expect(await memberAppRequestFrame(t.db, new URL('/approve-app', ORIGIN))).toBeNull()
    await answer('deny', request)
    expect(await memberAppRequestFrame(t.db, page)).toBeNull()
  })
})
