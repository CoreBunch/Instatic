/**
 * Apps on plugin member routes, end to end: a real plugin package installed
 * through the cms handler, running in its sandboxed worker, an app the owner
 * registered, and a member who signed in to it.
 *
 * Covers the manifest's `appScopes`, a route opening itself to apps, what an
 * app's token can and cannot reach, what the handler is told, and how the
 * scopes show up for the owner and the member.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_MEMBER_SETTINGS, pluginAppScopeText, type MemberAppListResponse } from '@core/members'
import { hookBus } from '@core/plugins/hookBus'
import { parsePluginManifest } from '@core/plugins/manifest'
import { resetPublicOrigins } from '../../../server/auth/security'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { memberAppRequestFrame } from '../../../server/members/apps/approval'
import { resetMemberAppLimits } from '../../../server/members/apps/handler'
import { resetMemberLimits } from '../../../server/members/limits'
import { flushMemberMail } from '../../../server/members/mail'
import { createMember, grantMemberTag, saveMemberSettings } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { pkceChallengeForVerifier } from '../../../server/oauth/secrets'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { handleServerRequest } from '../../../server/router'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { publishMemberPages } from '../helpers/memberPages'

const ORIGIN = 'http://localhost'
const ISSUER = `${ORIGIN}/_instatic/members`
const PLUGIN_ID = 'acme.shop'
const MOUNT = `/_instatic/plugins/${PLUGIN_ID}`
const READ = `plugin:${PLUGIN_ID}:read`
const CALLBACK = 'http://127.0.0.1:47821/callback'
const VERIFIER = 'v'.repeat(64)
const PERMISSIONS = ['cms.routes', 'cms.routes.public', 'members.read']

const PLUGIN_SOURCE = `
  export function activate(api) {
    const seen = (ctx) => ({
      member: ctx.member.email,
      app: ctx.app,
      authorization: ctx.req.headers.get('authorization'),
      cookie: ctx.req.headers.get('cookie'),
    })
    api.cms.routes.member.get('/orders', { app: { scope: 'read' } }, seen)
    api.cms.routes.member.get('/pro-orders', { tag: 'pro', app: { scope: 'read' } }, seen)
    api.cms.routes.member.post('/licenses', { app: { scope: 'manage' } }, (ctx) => ({ made: ctx.body.name, app: ctx.app }))
    // Never opened to apps.
    api.cms.routes.member.get('/account', seen)
    api.cms.routes.member.post('/cancel', (ctx) => ({ cancelled: true, app: ctx.app }))
    api.cms.routes.public.get('/echo', (ctx) => ({ authorization: ctx.req.headers.get('authorization') }))
  }
`

const APP_SCOPES = [
  { name: 'read', description: 'See your purchases and plan' },
  { name: 'manage', description: 'Create licences for you' },
]

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: PLUGIN_ID,
    name: 'Shop',
    version: '1.0.0',
    apiVersion: 1,
    permissions: PERMISSIONS,
    appScopes: APP_SCOPES,
    entrypoints: { server: 'server/index.js' },
    resources: [],
    adminPages: [],
    ...overrides,
  }
}

describe('apps on plugin member routes', () => {
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'plugin-app-routes-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    hookBus.reset()
    // The plugin host lives for the whole test process; start each case without the last one's plugin.
    hostPlugins.clear()
    resetPublicOrigins()
    resetMemberLimits()
    resetMemberAppLimits()
    await saveMemberSettings(h.db, {
      ...DEFAULT_MEMBER_SETTINGS,
      pages: await publishMemberPages(h.db, { login: '/sign-in', appSignIn: '/approve-app' }),
    })
  })

  afterEach(async () => {
    await flushMemberMail()
    resetPublicOrigins()
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(source = PLUGIN_SOURCE, overrides: Record<string, unknown> = {}, granted = PERMISSIONS): Promise<Response> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest(overrides))),
      'server/index.js': strToU8(source),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(granted))
    // The test DOM cannot carry a multipart body through `new Request`, so the form is handed over directly.
    const req = {
      url: `${ORIGIN}/admin/api/cms/plugins/package`,
      method: 'POST',
      headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
      formData: async () => formData,
    } as unknown as Request
    return handleCmsRequest(req, h.db, { uploadsDir })
  }

  function visit(
    path: string,
    init: { method?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string> } = {},
  ): Promise<Response> {
    const body = init.json !== undefined
      ? JSON.stringify(init.json)
      : init.form ? new URLSearchParams(init.form).toString() : undefined
    const req = new Request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', ...(body !== undefined ? { body } : {}) })
    if (init.json !== undefined) req.headers.set('content-type', 'application/json')
    if (init.form) req.headers.set('content-type', 'application/x-www-form-urlencoded')
    // Set after construction: the test DOM's Request drops `cookie` and `origin` from an init object.
    for (const [name, value] of Object.entries(init.headers ?? {})) req.headers.set(name, value)
    return handleServerRequest(req, { db: h.db, uploadsDir })
  }

  async function member(email: string, tags: string[] = []): Promise<{ id: string; cookie: string }> {
    const created = await createMember(h.db, { email, passwordHash: 'x', profile: { name: 'Ada' }, verified: true })
    for (const tag of tags) await grantMemberTag(h.db, { memberId: created!.id, tag, source: 'admin', expiresAt: null })
    const session = await createMemberSession(h.db, created!.id, { ipAddress: null, userAgent: null })
    return { id: created!.id, cookie: `instatic_member=${session.token}` }
  }

  /** The owner registers an app that may ask for `scopes`. */
  async function registerApp(scopes: string[]): Promise<Response> {
    // Step-up rotates the session, so the new cookie is the owner from here on.
    owner = await h.stepUp(owner)
    return h.cms('/admin/api/cms/members/apps', {
      method: 'POST', cookie: owner, json: { name: 'Shop Desktop', redirectUris: ['http://127.0.0.1/callback'], scopes },
    })
  }

  async function appId(scopes: string[]): Promise<string> {
    const res = await registerApp(scopes)
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  /** The address the app opens, answered as far as the redirect. */
  async function authorize(client: string, scope: string, cookie: string): Promise<Response> {
    const params = new URLSearchParams({
      response_type: 'code', client_id: client, redirect_uri: CALLBACK, scope, state: 's',
      code_challenge: await pkceChallengeForVerifier(VERIFIER), code_challenge_method: 'S256',
    })
    return visit(`/_instatic/members/oauth/authorize?${params}`, { headers: { cookie } })
  }

  /** The whole sign-in: the member allows the app, the app ends up with an access token. */
  async function signIn(client: string, scope: string, cookie: string): Promise<string> {
    const started = await authorize(client, scope, cookie)
    expect(started.status).toBe(302)
    const marker = /instatic_member_app=([A-Za-z0-9-]+)/.exec(started.headers.get('set-cookie') ?? '')![1]
    const request = new URL(started.headers.get('location')!, ORIGIN).searchParams.get('request')!
    const answered = await visit('/_instatic/members/apps/approve', {
      method: 'POST',
      headers: { cookie: `${cookie}; instatic_member_app=${marker}`, origin: ORIGIN },
      json: { request, decision: 'allow' },
    })
    expect(answered.status).toBe(200)
    const code = new URL(((await answered.json()) as { appRedirect: string }).appRedirect).searchParams.get('code')!
    const exchanged = await visit('/_instatic/members/oauth/token', {
      method: 'POST',
      form: { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: VERIFIER, client_id: client, resource: ISSUER },
    })
    expect(exchanged.status).toBe(200)
    return ((await exchanged.json()) as { access_token: string }).access_token
  }

  const asApp = (token: string) => ({ authorization: `Bearer ${token}` })

  describe('the manifest', () => {
    it('declares what an app may be allowed to do, and needs members.read for it', () => {
      expect(parsePluginManifest(manifest()).appScopes).toEqual(APP_SCOPES)
      expect(() => parsePluginManifest(manifest({ permissions: ['cms.routes'] }))).toThrow(/members\.read/)
      expect(() => parsePluginManifest(manifest({ appScopes: [APP_SCOPES[0], APP_SCOPES[0]] }))).toThrow(/declared twice/)
      expect(() => parsePluginManifest(manifest({ appScopes: [{ name: 'Read All', description: 'x' }] }))).toThrow()
      expect(() => parsePluginManifest(manifest({ appScopes: [{ name: 'read', description: '' }] }))).toThrow()
      // Text a member reads before pressing Allow: nothing that reorders or hides it.
      for (const description of ['Read\u202Eeverything', 'One thing\nAnother thing', 'Zero\u200Bwidth']) {
        expect(() => parsePluginManifest(manifest({ appScopes: [{ name: 'read', description }] }))).toThrow(/invisible/)
      }
    })

    it('refuses a description that says nothing, or says what a built-in scope says', () => {
      const withDescription = (description: string) => () =>
        parsePluginManifest(manifest({ appScopes: [{ name: 'read', description }] }))
      // Only spaces: the approval page would show the member an empty line.
      for (const description of [' ', '     ', '\u00A0 \u3000']) expect(withDescription(description)).toThrow(/is empty/)
      // The words core uses for `profile` and `access`, however cased or spaced, alone or inside more text.
      for (const description of [
        'Your name and email address',
        'your NAME and email   address',
        ' Which memberships and access you hold ',
        'See your purchases, Which memberships and access you hold',
      ]) {
        expect(withDescription(description)).toThrow(/built-in scope/)
      }
      expect(withDescription('See your name on your orders')).not.toThrow()
    })

    it('does not let a route open itself under a scope the manifest never declared', async () => {
      const res = await install(`
        export function activate(api) {
          api.cms.routes.member.get('/orders', { app: { scope: 'everything' } }, () => ({}))
        }
      `)
      expect(res.status).toBe(201)
      // The refused registration fails activation, so the plugin serves nothing at all.
      const ada = await member('ada@example.com')
      expect((await visit(`${MOUNT}/orders`, { headers: { cookie: ada.cookie } })).status).toBe(404)
    })
  })

  describe('what the owner sees and may give an app', () => {
    it('offers a plugin scope only while the plugin is installed', async () => {
      const before = (await (await h.cms('/admin/api/cms/members/apps', { cookie: owner })).json()) as MemberAppListResponse
      expect(before.availableScopes.map((option) => option.scope)).toEqual(['profile', 'access'])
      expect((await registerApp(['profile', READ])).status).toBe(400)

      expect((await install()).status).toBe(201)
      const after = (await (await h.cms('/admin/api/cms/members/apps', { cookie: owner })).json()) as MemberAppListResponse
      expect(after.availableScopes).toEqual([
        { scope: 'profile', text: 'Your name and email address' },
        { scope: 'access', text: 'Which memberships and access you hold' },
        { scope: READ, text: 'See your purchases and plan', plugin: { id: PLUGIN_ID, name: 'Shop' } },
        { scope: `plugin:${PLUGIN_ID}:manage`, text: 'Create licences for you', plugin: { id: PLUGIN_ID, name: 'Shop' } },
      ])
      expect((await registerApp(['profile', READ])).status).toBe(201)
      expect((await registerApp(['profile', `plugin:${PLUGIN_ID}:nothing`])).status).toBe(400)
      expect((await registerApp(['profile', 'plugin:other.plugin:read'])).status).toBe(400)
    })

    it('does not offer the scopes of a plugin that was not granted members.read', async () => {
      // Declared, but the owner unticked the grant at install: its member routes cannot exist.
      await install('export function activate() {}', {}, ['cms.routes'])
      const list = (await (await h.cms('/admin/api/cms/members/apps', { cookie: owner })).json()) as MemberAppListResponse
      expect(list.availableScopes.map((option) => option.scope)).toEqual(['profile', 'access'])
    })
  })

  describe('what the member is asked', () => {
    it('reads the plugin\'s own words on the approval page, behind core\'s words naming the plugin', async () => {
      await install()
      const client = await appId(['profile', READ])
      const ada = await member('ada@example.com')
      const started = await authorize(client, `profile ${READ}`, ada.cookie)
      const request = new URL(started.headers.get('location')!, ORIGIN).searchParams.get('request')!
      const frame = await memberAppRequestFrame(h.db, new URL(`/approve-app?request=${request}`, ORIGIN))
      expect(frame!.access).toBe('Your name and email address, Through the plugin \u201CShop\u201D: See your purchases and plan')
    })

    it('keeps a plugin\'s name inside core\'s quotation marks, whatever the name is', () => {
      const text = (name: string) => pluginAppScopeText({ id: PLUGIN_ID, name }, 'See your purchases')
      const framed = (name: string) => `Through the plugin \u201C${name}\u201D: See your purchases`
      // A comma or a colon in the name stays between the marks: still one entry, still the plugin's.
      expect(text('Shop, Billing')).toBe(framed('Shop, Billing'))
      expect(text('Shop: Everything')).toBe(framed('Shop: Everything'))
      // The name cannot close the quote itself, with any kind of double quotation mark.
      for (const name of [
        'Shop\u201D: nothing at all, Through the plugin \u201CBank',
        'Shop": nothing, "Bank',
        'Shop\u00BB: nothing, \u00ABBank',
        'Shop\uFF02\u201F\u301E',
      ]) {
        const shown = text(name)
        expect(shown.match(/[\u201C\u201D]/g)).toEqual(['\u201C', '\u201D'])
        expect(shown).not.toMatch(/["\u00AB\u00BB\u201F\u301E\uFF02]/)
        expect(shown.endsWith('\u201D: See your purchases')).toBe(true)
      }
      // A name that repeats a built-in scope's words, or says nothing, gives way to the plugin's id.
      for (const name of [
        'Your name and email address',
        'Shop, Which memberships and ACCESS you hold',
        'Your \u201Cname\u201D and email address',
        '   ',
        '\u201C\u201D',
      ]) {
        expect(text(name)).toBe(framed(PLUGIN_ID))
      }
    })

    it('does not count an Allow for a scope that went away while the member was deciding', async () => {
      await install()
      const client = await appId(['profile', READ])
      const ada = await member('ada@example.com')
      const started = await authorize(client, `profile ${READ}`, ada.cookie)
      const marker = /instatic_member_app=([A-Za-z0-9-]+)/.exec(started.headers.get('set-cookie') ?? '')![1]
      const request = new URL(started.headers.get('location')!, ORIGIN).searchParams.get('request')!

      // The owner removes the plugin while the approval page is open.
      owner = await h.stepUp(owner)
      expect((await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })).ok).toBe(true)

      const answered = await visit('/_instatic/members/apps/approve', {
        method: 'POST',
        headers: { cookie: `${ada.cookie}; instatic_member_app=${marker}`, origin: ORIGIN },
        json: { request, decision: 'allow' },
      })
      const back = new URL(((await answered.json()) as { appRedirect: string }).appRedirect)
      expect(back.searchParams.get('error')).toBe('invalid_scope')
      expect(back.searchParams.has('code')).toBe(false)
      const { rows } = await h.db<{ id: string }>`select id from member_app_grants where member_id = ${ada.id}`
      expect(rows).toEqual([])
    })

    it('refuses a sign-in that asks for more than the app was given, or for a scope no longer on offer', async () => {
      await install()
      const client = await appId(['profile', READ])
      const ada = await member('ada@example.com')
      const error = async (scope: string) =>
        new URL((await authorize(client, scope, ada.cookie)).headers.get('location')!).searchParams.get('error')
      expect(await error(`profile plugin:${PLUGIN_ID}:manage`)).toBe('invalid_scope')
      expect(await error('profile plugin:not a scope')).toBe('invalid_scope')

      // The plugin goes away: the scope it offered goes with it.
      owner = await h.stepUp(owner)
      const removed = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })
      expect(removed.ok).toBe(true)
      expect(await error(`profile ${READ}`)).toBe('invalid_scope')
    })
  })

  describe('an app calling a member route', () => {
    let client: string
    let ada: { id: string; cookie: string }

    beforeEach(async () => {
      expect((await install()).status).toBe(201)
      client = await appId(['profile', 'access', READ, `plugin:${PLUGIN_ID}:manage`])
      ada = await member('ada@example.com')
    })

    it('reaches a route opened under a scope its sign-in carries, as that member', async () => {
      const token = await signIn(client, `profile ${READ}`, ada.cookie)
      const res = await visit(`${MOUNT}/orders`, { headers: asApp(token) })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(await res.json()).toEqual({
        member: 'ada@example.com',
        app: { id: client, name: 'Shop Desktop', scope: 'read' },
        // The token stays with the host, like the session cookie does.
        authorization: null,
        cookie: null,
      })
    })

    it('tells the handler when it is the member\'s own browser instead', async () => {
      const res = await visit(`${MOUNT}/orders`, { headers: { cookie: ada.cookie } })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { app: unknown }).app).toBeNull()
    })

    it('is refused on a route that was never opened to apps, reading or writing', async () => {
      const token = await signIn(client, `profile ${READ} plugin:${PLUGIN_ID}:manage`, ada.cookie)
      expect((await visit(`${MOUNT}/account`, { headers: asApp(token) })).status).toBe(403)
      const write = await visit(`${MOUNT}/cancel`, { method: 'POST', headers: asApp(token), json: {} })
      expect(write.status).toBe(403)
      // Even with the member's own session riding along: a request that shows a token is the app's.
      const both = await visit(`${MOUNT}/account`, { headers: { ...asApp(token), cookie: ada.cookie } })
      expect(both.status).toBe(403)
      expect((await visit(`${MOUNT}/account`, { headers: { cookie: ada.cookie } })).status).toBe(200)
    })

    it('is refused without the route\'s scope, whatever else its sign-in carries', async () => {
      const profileOnly = await signIn(client, 'profile access', ada.cookie)
      const res = await visit(`${MOUNT}/orders`, { headers: asApp(profileOnly) })
      expect(res.status).toBe(403)
      expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')

      const readOnly = await signIn(client, `profile ${READ}`, ada.cookie)
      expect((await visit(`${MOUNT}/licenses`, { method: 'POST', headers: asApp(readOnly), json: { name: 'x' } })).status).toBe(403)
      const manage = await signIn(client, `plugin:${PLUGIN_ID}:manage`, ada.cookie)
      const made = await visit(`${MOUNT}/licenses`, { method: 'POST', headers: asApp(manage), json: { name: 'Studio' } })
      expect(made.status).toBe(200)
      expect(await made.json()).toEqual({ made: 'Studio', app: { id: client, name: 'Shop Desktop', scope: 'manage' } })
    })

    it('still has to satisfy the route\'s tag, through the member it speaks for', async () => {
      const token = await signIn(client, READ, ada.cookie)
      expect((await visit(`${MOUNT}/pro-orders`, { headers: asApp(token) })).status).toBe(403)
      await grantMemberTag(h.db, { memberId: ada.id, tag: 'pro', source: 'admin', expiresAt: null })
      expect((await visit(`${MOUNT}/pro-orders`, { headers: asApp(token) })).status).toBe(200)
    })

    it('is refused with a token that is wrong, of another kind, or no longer live', async () => {
      const token = await signIn(client, READ, ada.cookie)
      for (const bad of ['Bearer imem_at_' + 'x'.repeat(40), 'Bearer short', `Bearer ${token} extra`, 'Bearer ', 'Bearer']) {
        const res = await visit(`${MOUNT}/orders`, { headers: { authorization: bad } })
        expect(`${bad.slice(0, 12)} ${res.status}`).toBe(`${bad.slice(0, 12)} 401`)
      }
      // The scheme is not case-sensitive (RFC 9110), so this is the same token.
      expect((await visit(`${MOUNT}/orders`, { headers: { authorization: `bearer ${token}` } })).status).toBe(200)
      // The member disconnects the app.
      const { rows } = await h.db<{ id: string }>`select id from member_app_grants where member_id = ${ada.id}`
      await visit('/_instatic/members/apps/disconnect', {
        method: 'POST', headers: { cookie: ada.cookie, origin: ORIGIN }, json: { connection: rows[0]!.id },
      })
      expect((await visit(`${MOUNT}/orders`, { headers: asApp(token) })).status).toBe(401)
    })

    it('does not need the site\'s origin, since no cookie is acting', async () => {
      const token = await signIn(client, `plugin:${PLUGIN_ID}:manage`, ada.cookie)
      const res = await visit(`${MOUNT}/licenses`, {
        method: 'POST', headers: { ...asApp(token), origin: 'https://elsewhere.example' }, json: { name: 'x' },
      })
      expect(res.status).toBe(200)
    })

    it('leaves a public route its own authorization header, but never hands it an app\'s token', async () => {
      const res = await visit(`${MOUNT}/echo`, { headers: { authorization: 'Bearer webhook-secret-of-the-plugins-own' } })
      expect(await res.json()).toEqual({ authorization: 'Bearer webhook-secret-of-the-plugins-own' })
      // An app that sends its token to everything on the mount: the public handler does not get it.
      const token = await signIn(client, `profile ${READ}`, ada.cookie)
      const withToken = await visit(`${MOUNT}/echo`, { headers: asApp(token) })
      expect(await withToken.json()).toEqual({ authorization: null })
      // However the header is written: another letter case, extra spaces, something after the token.
      for (const header of [`bearer ${token}`, `BEARER   ${token}`, `Bearer ${token} extra`, `Bearer x ${token}`]) {
        const res = await visit(`${MOUNT}/echo`, { headers: { authorization: header } })
        expect(await res.json()).toEqual({ authorization: null })
      }
    })

    it('never hands a handler an app\'s token, whatever scheme it was sent under', async () => {
      const token = await signIn(client, `profile ${READ}`, ada.cookie)
      const disguised = [
        `DPoP ${token}`,
        `Token ${token}`,
        `dPoP   ${token}`,
        `tOkEn ${token}   extra`,
        `Custom key="${token}"`,
        token,
        // Even respelled: the secret half is still the token's.
        `Token ${token.replace('imem_at_', 'IMEM_AT_')}`,
      ]
      for (const authorization of disguised) {
        // A public route.
        const open = await visit(`${MOUNT}/echo`, { headers: { authorization } })
        expect(`${authorization.slice(0, 14)} ${JSON.stringify(await open.json())}`)
          .toBe(`${authorization.slice(0, 14)} {"authorization":null}`)
        // A member route the session cookie opened: not an app's call, and still no token.
        const mine = await visit(`${MOUNT}/account`, { headers: { authorization, cookie: ada.cookie } })
        expect(mine.status).toBe(200)
        expect(await mine.json()).toEqual({ member: 'ada@example.com', app: null, authorization: null, cookie: null })
        // And it opened nothing by itself.
        expect((await visit(`${MOUNT}/orders`, { headers: { authorization } })).status).toBe(401)
      }
      // A refresh token is no more the plugin's to see.
      const refresh = await visit(`${MOUNT}/echo`, { headers: { authorization: `Token imem_rt_${'r'.repeat(40)}` } })
      expect(await refresh.json()).toEqual({ authorization: null })

      // A plugin's own secret does not look like one and passes, on both kinds of route.
      const own = 'Token webhook-secret-of-the-plugins-own'
      expect(await (await visit(`${MOUNT}/echo`, { headers: { authorization: own } })).json()).toEqual({ authorization: own })
      const account = await visit(`${MOUNT}/account`, { headers: { authorization: own, cookie: ada.cookie } })
      expect(((await account.json()) as { authorization: string }).authorization).toBe(own)
    })

    it('still answers the member\'s browser on a site behind HTTP Basic auth', async () => {
      // The browser sends the proxy's credentials with every request; that is not an app.
      const headers = { authorization: 'Basic c3RhZ2luZzpzZWNyZXQ=', cookie: ada.cookie }
      expect((await visit(`${MOUNT}/account`, { headers })).status).toBe(200)
      const orders = await visit(`${MOUNT}/orders`, { headers })
      expect(orders.status).toBe(200)
      expect(((await orders.json()) as { app: unknown }).app).toBeNull()
      // And a write on that path still has to come from the site itself.
      const write = await visit(`${MOUNT}/cancel`, { method: 'POST', headers: { ...headers, origin: 'https://elsewhere.example' }, json: {} })
      expect(write.status).toBe(403)
    })

    it('ends what the plugin\'s scopes allowed when the plugin is removed', async () => {
      const token = await signIn(client, `profile ${READ}`, ada.cookie)
      const profileOnly = await signIn(client, 'profile', ada.cookie)
      owner = await h.stepUp(owner)
      expect((await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })).ok).toBe(true)

      const userinfo = (bearer: string) => visit('/_instatic/members/oauth/userinfo', { headers: asApp(bearer) })
      // The sign-in that carried the plugin's scope is over; one that did not is untouched.
      expect((await userinfo(token)).status).toBe(401)
      expect((await userinfo(profileOnly)).status).toBe(200)
      const list = (await (await h.cms('/admin/api/cms/members/apps', { cookie: owner })).json()) as MemberAppListResponse
      expect(list.apps.find((app) => app.id === client)!.scopes).toEqual(['profile', 'access'])

      // The same id installed again starts from nothing: the app has to be given the scope anew.
      expect((await install()).status).toBe(201)
      expect((await visit(`${MOUNT}/orders`, { headers: asApp(token) })).status).toBe(401)
      const again = await authorize(client, `profile ${READ}`, ada.cookie)
      expect(new URL(again.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope')
    })

    it('ends them with the plugin row, even when the rest of the removal fails', async () => {
      const token = await signIn(client, `profile ${READ}`, ada.cookie)
      // A cleanup step that runs after the row is deleted is made to throw.
      await h.db.unsafe('drop table plugin_crash_events')
      owner = await h.stepUp(owner)
      const removal = await h
        .cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'DELETE', cookie: owner })
        .then((res) => res.ok, () => false)
      expect(removal).toBe(false)

      // The plugin is gone, and nothing it let an app do is left for the next package under its id.
      const { rows: plugins } = await h.db<{ id: string }>`select id from installed_plugins where id = ${PLUGIN_ID}`
      expect(plugins).toEqual([])
      expect((await visit('/_instatic/members/oauth/userinfo', { headers: asApp(token) })).status).toBe(401)
      const { rows: apps } = await h.db<{ scopes_json: string[] }>`select scopes_json from member_apps where id = ${client}`
      expect(apps[0]!.scopes_json).toEqual(['profile', 'access'])
    })

    describe('when the plugin is updated', () => {
      const MANAGE = `plugin:${PLUGIN_ID}:manage`
      const userinfo = (bearer: string) => visit('/_instatic/members/oauth/userinfo', { headers: asApp(bearer) })
      const appScopes = async () => {
        const list = (await (await h.cms('/admin/api/cms/members/apps', { cookie: owner })).json()) as MemberAppListResponse
        return list.apps.find((app) => app.id === client)!.scopes
      }

      it('withdraws a scope the update describes differently, and leaves the others alone', async () => {
        const read = await signIn(client, `profile ${READ}`, ada.cookie)
        const manage = await signIn(client, MANAGE, ada.cookie)
        expect((await visit(`${MOUNT}/orders`, { headers: asApp(read) })).status).toBe(200)

        // Same id, same scope name, other words: what the member allowed is not what `read` now means.
        const updated = await install(PLUGIN_SOURCE, {
          version: '1.1.0',
          appScopes: [{ name: 'read', description: 'See and change your purchases' }, APP_SCOPES[1]],
        })
        expect(updated.status).toBe(200)

        // The old token opens nothing: not the plugin's routes, not the profile it also carried.
        expect((await visit(`${MOUNT}/orders`, { headers: asApp(read) })).status).toBe(401)
        expect((await userinfo(read)).status).toBe(401)
        // The scope that reads the same kept its approval.
        const made = await visit(`${MOUNT}/licenses`, { method: 'POST', headers: asApp(manage), json: { name: 'Studio' } })
        expect(made.status).toBe(200)
        // The reworded scope is off the app until the owner gives it back.
        expect(await appScopes()).toEqual(['profile', 'access', MANAGE])
        const again = await authorize(client, `profile ${READ}`, ada.cookie)
        expect(new URL(again.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope')
      })

      it('keeps every approval when the scopes read the same', async () => {
        const read = await signIn(client, `profile ${READ}`, ada.cookie)
        expect((await install(PLUGIN_SOURCE, { version: '1.1.0' })).status).toBe(200)
        expect((await visit(`${MOUNT}/orders`, { headers: asApp(read) })).status).toBe(200)
        expect((await userinfo(read)).status).toBe(200)
        expect(await appScopes()).toEqual(['profile', 'access', READ, MANAGE])
      })

      it('withdraws a scope the update no longer declares', async () => {
        const read = await signIn(client, `profile ${READ}`, ada.cookie)
        const manage = await signIn(client, MANAGE, ada.cookie)
        const updated = await install(
          `export function activate(api) {
            api.cms.routes.member.post('/licenses', { app: { scope: 'manage' } }, (ctx) => ({ made: ctx.body.name }))
          }`,
          { version: '1.1.0', appScopes: [APP_SCOPES[1]] },
        )
        expect(updated.status).toBe(200)
        expect((await userinfo(read)).status).toBe(401)
        // The sign-in that never carried it goes on.
        expect((await userinfo(manage)).status).toBe(200)
        const made = await visit(`${MOUNT}/licenses`, { method: 'POST', headers: asApp(manage), json: { name: 'Studio' } })
        expect(made.status).toBe(200)
        expect(await appScopes()).toEqual(['profile', 'access', MANAGE])
      })
    })
  })
})
