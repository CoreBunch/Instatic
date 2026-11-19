/**
 * Site members for plugins, end to end: a real plugin package installed
 * through the cms handler, running in its sandboxed worker, against a real
 * database.
 *
 * Covers the public plugin mount, member-only routes, what a plugin learns
 * about the signed-in member, the `cms.members.*` calls and the member
 * events, and the permission each of them needs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { hookBus } from '@core/plugins/hookBus'
import { configurePublicOrigins, resetPublicOrigins } from '../../../server/auth/security'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { flushMemberMail } from '../../../server/members/mail'
import { DEFAULT_MEMBER_SETTINGS } from '@core/members'
import { createMember, findMemberByEmail, grantMemberTag, listActiveMemberTags, saveMemberSettings } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { handleServerRequest } from '../../../server/router'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { publishMemberPages } from '../helpers/memberPages'

const ORIGIN = 'http://localhost'
const PLUGIN_ID = 'acme.club'
const MOUNT = `/_instatic/plugins/${PLUGIN_ID}`
const ALL = ['cms.routes', 'cms.routes.public', 'cms.hooks', 'members.read', 'members.write', 'members.tags']

/** What the test plugin does. Events it hears are kept in memory and read back through a route. */
const PLUGIN_SOURCE = `
  export function activate(api) {
    const heard = []
    for (const event of ['member.created', 'member.verified', 'member.signedIn', 'member.tagged', 'member.deleted']) {
      api.cms.hooks.on(event, (payload) => { heard.push({ event, ...payload }) })
    }
    api.cms.routes.public.get('/heard', () => ({ heard }))

    api.cms.routes.member.get('/me', (ctx) => ({
      member: ctx.member,
      user: ctx.user,
      cookie: ctx.req.headers.get('cookie'),
    }))
    api.cms.routes.member.get('/lounge', { tag: 'pro' }, (ctx) => ({ welcome: ctx.member.email }))
    api.cms.routes.member.post('/note', (ctx) => ({ saved: ctx.body.text, by: ctx.member.id }))

    api.cms.routes.public.get('/who', (ctx) => ({ member: ctx.member ? ctx.member.email : null }))
    api.cms.routes.public.post('/hook', () => ({ received: true }))
    api.cms.routes.public.post('/call', async (ctx) => {
      const { action, memberId, email, tag, expiresAt, tags } = ctx.body
      try {
        if (action === 'get') return { result: await api.cms.members.get(memberId ? { id: memberId } : { email }) }
        if (action === 'invite') return { result: await api.cms.members.invite(tags ? { email, tags } : { email }) }
        if (action === 'grant') return { result: await api.cms.members.tags.grant(memberId, tag, expiresAt ? { expiresAt } : {}) ?? 'ok' }
        if (action === 'revoke') return { result: await api.cms.members.tags.revoke(memberId, tag) ?? 'ok' }
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
      return { error: 'unknown action' }
    })

    api.cms.routes.get('/admin-only', 'plugins.read', () => ({ admin: true }))
  }
`

function manifest(permissions: string[], id = PLUGIN_ID) {
  return {
    id,
    name: 'Club',
    version: '1.0.0',
    apiVersion: 1,
    permissions,
    entrypoints: { server: 'server/index.js' },
    resources: [],
    adminPages: [],
  }
}

describe('site members for plugins', () => {
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'plugin-members-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    hookBus.reset()
    resetPublicOrigins()
  })

  afterEach(async () => {
    await flushMemberMail()
    resetPublicOrigins()
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(permissions: string[], source = PLUGIN_SOURCE, id = PLUGIN_ID): Promise<Response> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest(permissions, id))),
      'server/index.js': strToU8(source),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(permissions))
    // The test DOM cannot carry a multipart body through `new Request`, so the form is handed over directly.
    const req = {
      url: `${ORIGIN}/admin/api/cms/plugins/package`,
      method: 'POST',
      headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
      formData: async () => formData,
    } as unknown as Request
    return handleCmsRequest(req, h.db, { uploadsDir })
  }

  function visit(path: string, init: { method?: string; cookie?: string; json?: unknown; origin?: string | null } = {}): Promise<Response> {
    const method = init.method ?? 'GET'
    const req = new Request(`${ORIGIN}${path}`, {
      method,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    })
    if (init.json !== undefined) req.headers.set('content-type', 'application/json')
    if (init.cookie) req.headers.set('cookie', init.cookie)
    const origin = init.origin === undefined ? (method === 'GET' ? null : ORIGIN) : init.origin
    if (origin) req.headers.set('origin', origin)
    return handleServerRequest(req, { db: h.db, uploadsDir })
  }

  async function member(email: string, tags: string[] = []): Promise<{ id: string; cookie: string }> {
    const created = await createMember(h.db, { email, passwordHash: 'x', profile: { name: 'Ada' }, verified: true })
    for (const tag of tags) await grantMemberTag(h.db, { memberId: created!.id, tag, source: 'admin', expiresAt: null })
    const session = await createMemberSession(h.db, created!.id, { ipAddress: null, userAgent: null })
    return { id: created!.id, cookie: `instatic_member=${session.token}; theme=dark` }
  }

  const call = async (body: Record<string, unknown>) =>
    (await (await visit(`${MOUNT}/call`, { method: 'POST', json: body })).json()) as { result?: unknown; error?: string }
  const heard = async () =>
    ((await (await visit(`${MOUNT}/heard`)).json()) as { heard: Array<Record<string, unknown>> }).heard

  describe('member routes', () => {
    it('reach the handler only for a signed-in member, with the member and without the session cookie', async () => {
      expect((await install(ALL)).status).toBe(201)
      const anonymous = await visit(`${MOUNT}/me`)
      expect(anonymous.status).toBe(401)
      expect(anonymous.headers.get('cache-control')).toBe('private, no-store')

      const ada = await member('ada@example.com', ['student'])
      const res = await visit(`${MOUNT}/me`, { cookie: ada.cookie })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(await res.json()).toEqual({
        member: { id: ada.id, email: 'ada@example.com', tags: ['student'], profile: { name: 'Ada' } },
        user: null,
        // The plugin is told who the member is; it never holds their session.
        cookie: 'theme=dark',
      })
    })

    it('can require a tag', async () => {
      await install(ALL)
      const plain = await member('plain@example.com')
      const pro = await member('pro@example.com', ['pro'])
      expect((await visit(`${MOUNT}/lounge`, { cookie: plain.cookie })).status).toBe(403)
      expect(await (await visit(`${MOUNT}/lounge`, { cookie: pro.cookie })).json()).toEqual({ welcome: 'pro@example.com' })
    })

    it('accept a write only from the site itself', async () => {
      await install(ALL)
      const ada = await member('ada@example.com')
      const post = (origin: string | null) =>
        visit(`${MOUNT}/note`, { method: 'POST', cookie: ada.cookie, json: { text: 'hi' }, origin })
      expect((await post('https://evil.example')).status).toBe(403)
      // A browser always names its origin on a POST; a request that does not is not one.
      expect((await post(null)).status).toBe(403)
      expect(await (await post(ORIGIN)).json()).toEqual({ saved: 'hi', by: ada.id })
    })

    it('are not served on the admin mount, and admin routes are not served on the public one', async () => {
      await install(ALL)
      const ada = await member('ada@example.com')
      const onAdminMount = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}/runtime/me`, { cookie: `${owner}; ${ada.cookie}` })
      expect(onAdminMount.status).toBe(404)
      expect((await visit(`${MOUNT}/admin-only`, { cookie: ada.cookie })).status).toBe(404)
      expect((await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}/runtime/admin-only`, { cookie: owner })).status).toBe(200)
    })

    it('cannot be registered without members.read', async () => {
      const res = await install(
        ['cms.routes', 'cms.routes.public'],
        `export function activate(api) {
           api.cms.routes.public.get('/who', (ctx) => ({ member: ctx.member ? ctx.member.email : null }))
           api.cms.routes.member.get('/me', (ctx) => ctx.member)
         }`,
      )
      expect(res.status).toBe(201)
      // The denied registration fails activation, so the plugin serves nothing at all.
      const ada = await member('ada@example.com')
      expect((await visit(`${MOUNT}/who`, { cookie: ada.cookie })).status).toBe(404)
      expect((await visit(`${MOUNT}/me`, { cookie: ada.cookie })).status).toBe(404)
    })
  })

  describe('public routes on the public mount', () => {
    it('tell a plugin who is signed in only when it may read members', async () => {
      await install(ALL)
      const ada = await member('ada@example.com')
      expect(await (await visit(`${MOUNT}/who`)).json()).toEqual({ member: null })
      expect(await (await visit(`${MOUNT}/who`, { cookie: ada.cookie })).json()).toEqual({ member: 'ada@example.com' })

      await install(
        ['cms.routes', 'cms.routes.public'],
        `export function activate(api) {
           api.cms.routes.public.get('/who', (ctx) => ({ member: ctx.member ? ctx.member.email : null, cookie: ctx.req.headers.get('cookie') }))
         }`,
        'acme.blind',
      )
      expect(await (await visit('/_instatic/plugins/acme.blind/who', { cookie: ada.cookie })).json()).toEqual({
        member: null,
        cookie: 'theme=dark',
      })
    })

    it('take a webhook with no origin, and refuse a post that names another site', async () => {
      await install(ALL)
      expect((await visit(`${MOUNT}/hook`, { method: 'POST', json: {}, origin: null })).status).toBe(200)
      expect((await visit(`${MOUNT}/hook`, { method: 'POST', json: {}, origin: 'https://evil.example' })).status).toBe(403)
    })

    it('refuse a body over the limit, whatever length it declares', async () => {
      await install(ALL)
      const big = 'x'.repeat(1024 * 1024 + 10)
      const send = (declared: string | null) => {
        const req = new Request(`${ORIGIN}${MOUNT}/hook`, { method: 'POST', body: big })
        // A missing or false Content-Length must not get a large body through.
        if (declared === null) req.headers.delete('content-length')
        else req.headers.set('content-length', declared)
        return handleServerRequest(req, { db: h.db, uploadsDir })
      }
      expect((await send(null)).status).toBe(413)
      expect((await send('10')).status).toBe(413)
      expect((await send(String(big.length))).status).toBe(413)
    })

    it('answer 404 for a plugin or a path that does not exist', async () => {
      await install(ALL)
      expect((await visit('/_instatic/plugins/nope/who')).status).toBe(404)
      expect((await visit(`${MOUNT}/nope`)).status).toBe(404)
      expect((await visit('/_instatic/plugins/%E0%A4%A/who')).status).toBe(404)
    })
  })

  describe('cms.members', () => {
    it('looks a member up by id or email, without anything secret', async () => {
      await install(ALL)
      const ada = await member('ada@example.com', ['pro'])
      const byEmail = await call({ action: 'get', email: 'ADA@example.com' })
      expect(byEmail.result).toMatchObject({ id: ada.id, email: 'ada@example.com', status: 'active', tags: ['pro'], profile: { name: 'Ada' } })
      expect(JSON.stringify(byEmail.result)).not.toContain('passwordHash')
      expect((await call({ action: 'get', memberId: ada.id })).result).toMatchObject({ email: 'ada@example.com' })
      expect((await call({ action: 'get', email: 'nobody@example.com' })).result ?? null).toBeNull()
    })

    it('grants tags as itself and can only take back its own', async () => {
      await install(ALL)
      const ada = await member('ada@example.com', ['pro'])
      const later = new Date(Date.now() + 86_400_000).toISOString()
      expect((await call({ action: 'grant', memberId: ada.id, tag: 'gold', expiresAt: later })).result).toBe('ok')
      expect(await listActiveMemberTags(h.db, ada.id)).toEqual(['gold', 'pro'])
      const { rows } = await h.db<{ tag: string; source: string }>`
        select tag, source from member_tags where member_id = ${ada.id} order by tag
      `
      expect(rows).toEqual([{ tag: 'gold', source: PLUGIN_ID }, { tag: 'pro', source: 'admin' }])

      // The administrator's `pro` is not the plugin's to remove.
      await call({ action: 'revoke', memberId: ada.id, tag: 'pro' })
      await call({ action: 'revoke', memberId: ada.id, tag: 'gold' })
      expect(await listActiveMemberTags(h.db, ada.id)).toEqual(['pro'])

      expect((await call({ action: 'grant', memberId: ada.id, tag: 'instatic:locked' })).error).toBeDefined()
      expect((await call({ action: 'grant', memberId: ada.id, tag: 'old', expiresAt: '2020-01-01T00:00:00Z' })).error).toContain('future')
      expect((await call({ action: 'grant', memberId: 'nope', tag: 'gold' })).error).toContain('not found')
    })

    it('invites through the site email, and only when the site can send it', async () => {
      await install(ALL)
      // No configured public address: there is no request to take a link address from.
      expect((await call({ action: 'invite', email: 'new@example.com' })).error).toContain('public address')
      expect(await findMemberByEmail(h.db, 'new@example.com')).toBeNull()

      configurePublicOrigins(['http://localhost'])
      // And there is nothing to invite anyone to until the site has a page for it.
      expect((await call({ action: 'invite', email: 'new@example.com' })).error).toContain('invitation page')
      expect(await findMemberByEmail(h.db, 'new@example.com')).toBeNull()
      await saveMemberSettings(h.db, { ...DEFAULT_MEMBER_SETTINGS, pages: await publishMemberPages(h.db, { invite: '/invitation' }) })
      const invited = await call({ action: 'invite', email: 'new@example.com', tags: ['student'] })
      expect(invited.result).toMatchObject({ outcome: 'invited' })
      const created = await findMemberByEmail(h.db, 'new@example.com')
      expect(created?.passwordHash).toBeNull()
      const { rows } = await h.db<{ source: string }>`select source from member_tags where member_id = ${created!.id}`
      expect(rows).toEqual([{ source: PLUGIN_ID }])
      expect((await call({ action: 'invite', email: 'new@example.com' })).result).toMatchObject({ outcome: 'resent' })

      await member('ada@example.com')
      expect((await call({ action: 'invite', email: 'ada@example.com' })).error).toContain('already has an account')
    })

    it('needs the permission for each call', async () => {
      // The same plugin without its hooks, holding only the right to read members.
      const source = PLUGIN_SOURCE.replace(/const heard = \[\][\s\S]*?api\.cms\.routes\.public\.get\('\/heard'[^\n]*\n/, '')
      await install(['cms.routes', 'cms.routes.public', 'members.read'], source)
      const ada = await member('ada@example.com')
      expect((await call({ action: 'get', memberId: ada.id })).result).toMatchObject({ email: 'ada@example.com' })
      expect((await call({ action: 'grant', memberId: ada.id, tag: 'gold' })).error).toContain('members.tags')
      expect((await call({ action: 'invite', email: 'new@example.com' })).error).toContain('members.write')
      expect(await listActiveMemberTags(h.db, ada.id)).toEqual([])
    })
  })

  describe('member events', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

    it('reach a plugin that may read members', async () => {
      await install(ALL)
      const ada = await member('ada@example.com')
      await call({ action: 'grant', memberId: ada.id, tag: 'gold' })
      await settle()
      const events = await heard()
      expect(events).toContainEqual({ event: 'member.created', memberId: ada.id, email: 'ada@example.com' })
      expect(events).toContainEqual({ event: 'member.verified', memberId: ada.id, email: 'ada@example.com' })
      expect(events).toContainEqual({ event: 'member.tagged', memberId: ada.id, tag: 'gold', source: PLUGIN_ID, expiresAt: null })
    })

    it('are refused to a plugin that may not', async () => {
      await install(
        ['cms.routes', 'cms.routes.public', 'cms.hooks'],
        `export function activate(api) {
           api.cms.routes.public.get('/before', () => ({ ok: true }))
           api.cms.hooks.on('member.created', () => {})
           api.cms.routes.public.get('/after', () => ({ ok: true }))
         }`,
      )
      // Subscribing is refused, which fails activation.
      expect((await visit(`${MOUNT}/before`)).status).toBe(404)
      expect((await visit(`${MOUNT}/after`)).status).toBe(404)
      expect(hookBus.hasListenersFor('member.created')).toBe(false)
    })
  })
})
