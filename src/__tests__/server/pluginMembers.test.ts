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
import { createMailConnector } from '../../../server/mail/connectors'
import { saveMailDefaults } from '../../../server/mail/defaults'
import { flushMemberMail } from '../../../server/members/mail'
import { resetMemberLimits } from '../../../server/members/limits'
import { exportMemberDataWithPlugins, fitsJson } from '../../../server/plugins/host/memberExport'
import { DEFAULT_MEMBER_SETTINGS } from '@core/members'
import { deleteMemberAsAdmin, ensureMember, setMemberSuspended } from '../../../server/members/admin'
import { confirmSignInLink } from '../../../server/members/service'
import { issueMemberToken } from '../../../server/members/tokens'
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
        if (action === 'ensure') return { result: await api.cms.members.ensure(tags ? { email, tags } : { email }) }
        if (action === 'ensureTogether') {
          const calls = []
          for (let i = 0; i < 10; i++) calls.push(api.cms.members.ensure({ email: i % 2 ? email.toUpperCase() : email }))
          return { result: await Promise.all(calls) }
        }
        if (action === 'emailStatus') return { result: await api.cms.members.emailStatus() }
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

function manifest(permissions: string[], id = PLUGIN_ID, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
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

  async function install(
    permissions: string[],
    source = PLUGIN_SOURCE,
    id = PLUGIN_ID,
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest(permissions, id, extra))),
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

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
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

    describe('ensure', () => {
      type Ensured = {
        member: { id: string; email: string; status: string; emailVerified: boolean; tags: string[]; profile: Record<string, unknown> }
        created: boolean
        confirmed: boolean
      }

      it('creates a member with no password and sends nothing, and records who did it', async () => {
        await install(ALL)
        const { result } = await call({ action: 'ensure', email: '  Buyer@Example.com ', tags: ['customer'] })
        const ensured = result as Ensured
        expect(ensured.created).toBe(true)
        expect(ensured.confirmed).toBe(false)
        expect(ensured.member).toMatchObject({ email: 'Buyer@Example.com', status: 'active', emailVerified: false, tags: ['customer'] })

        const stored = await findMemberByEmail(h.db, 'buyer@example.com')
        expect(stored).toMatchObject({ id: ensured.member.id, passwordHash: null, emailVerifiedAt: null, status: 'active' })
        await flushMemberMail()
        const { rows: mail } = await h.db<{ id: string }>`select id from mail_outbox`
        expect(mail).toEqual([])
        const { rows: tokens } = await h.db<{ kind: string }>`select kind from member_tokens where member_id = ${ensured.member.id}`
        expect(tokens).toEqual([])
        const { rows: events } = await h.db<{ kind: string; metadata_json: unknown }>`
          select kind, metadata_json from member_events where member_id = ${ensured.member.id}
        `
        expect(events).toEqual([{ kind: 'created_by_plugin', metadata_json: { plugin: PLUGIN_ID } }])
        const { rows: audit } = await h.db<{ actor_user_id: string | null; target_id: string; metadata_json: unknown }>`
          select actor_user_id, target_id, metadata_json from audit_events where action = 'member.create'
        `
        expect(audit).toEqual([
          { actor_user_id: null, target_id: ensured.member.id, metadata_json: { email: 'Buyer@Example.com', pluginId: PLUGIN_ID } },
        ])
        const { rows: grants } = await h.db<{ source: string; expires_at: string | null }>`
          select source, expires_at from member_tags where member_id = ${ensured.member.id}
        `
        expect(grants).toEqual([{ source: PLUGIN_ID, expires_at: null }])
      })

      it('lets the created member in with a sign-in link, which confirms the address', async () => {
        await install(ALL)
        const ensured = (await call({ action: 'ensure', email: 'buyer@example.com' })).result as Ensured
        const { token } = await issueMemberToken(h.db, ensured.member.id, 'magic')
        const ctx = { db: h.db, linkOrigin: null, mailAvailable: false, ipAddress: null, userAgent: null }
        const outcome = await confirmSignInLink(ctx, { token, ip: '203.0.113.9' })
        expect(outcome).toMatchObject({ ok: true, code: 'signed_in' })
        expect((await findMemberByEmail(h.db, 'buyer@example.com'))?.emailVerifiedAt).not.toBeNull()
      })

      it('returns an existing member as it is, without a new audit entry, and keeps its own grants', async () => {
        await install(ALL)
        const ada = await member('ada@example.com')
        const later = new Date(Date.now() + 86_400_000).toISOString()
        await call({ action: 'grant', memberId: ada.id, tag: 'gold', expiresAt: later })
        const ensured = (await call({ action: 'ensure', email: 'ADA@example.com', tags: ['gold', 'silver'] })).result as Ensured
        expect(ensured.created).toBe(false)
        expect(ensured.confirmed).toBe(true)
        expect(ensured.member).toMatchObject({ id: ada.id, email: 'ada@example.com', emailVerified: true, tags: ['gold', 'silver'] })
        // The plugin's earlier grant keeps its end date; only the missing tag is added.
        const { rows } = await h.db<{ tag: string; expires_at: string | null }>`
          select tag, expires_at from member_tags where member_id = ${ada.id} order by tag
        `
        expect(rows).toEqual([{ tag: 'gold', expires_at: later }, { tag: 'silver', expires_at: null }])
        const { rows: audit } = await h.db<{ id: string }>`select id from audit_events where action = 'member.create'`
        expect(audit).toEqual([])
      })

      it('replaces its own expired grant, and says so', async () => {
        await install(ALL)
        const ada = await member('ada@example.com')
        const past = new Date(Date.now() - 60_000).toISOString()
        await grantMemberTag(h.db, { memberId: ada.id, tag: 'gold', source: PLUGIN_ID, expiresAt: past })
        // Someone else's expired grant of the same tag is not this plugin's to touch.
        await grantMemberTag(h.db, { memberId: ada.id, tag: 'gold', source: 'admin', expiresAt: past })
        await settle()
        const before = (await heard()).filter((entry) => entry.event === 'member.tagged').length
        const ensured = (await call({ action: 'ensure', email: 'ada@example.com', tags: ['gold'] })).result as Ensured
        expect(ensured.member.tags).toEqual(['gold'])
        const { rows } = await h.db<{ source: string; expires_at: string | null }>`
          select source, expires_at from member_tags where member_id = ${ada.id} order by source
        `
        expect(rows).toEqual([{ source: PLUGIN_ID, expires_at: null }, { source: 'admin', expires_at: past }])
        await settle()
        const tagged = (await heard()).filter((entry) => entry.event === 'member.tagged')
        expect(tagged).toHaveLength(before + 1)
        expect(tagged.at(-1)).toMatchObject({ memberId: ada.id, tag: 'gold', source: PLUGIN_ID, expiresAt: null })

        // A second call while the new grant is active changes nothing and says nothing.
        await call({ action: 'ensure', email: 'ada@example.com', tags: ['gold'] })
        await settle()
        expect((await heard()).filter((entry) => entry.event === 'member.tagged')).toHaveLength(before + 1)
      })

      it('says an unfinished sign-up is unconfirmed and leaves it as it is', async () => {
        await install(ALL)
        const stranger = await createMember(h.db, { email: 'buyer@example.com', passwordHash: null, profile: { name: 'Typed by someone' }, verified: false })
        const ensured = (await call({ action: 'ensure', email: 'buyer@example.com' })).result as Ensured
        expect(ensured).toMatchObject({ created: false, confirmed: false, member: { id: stranger!.id, profile: { name: 'Typed by someone' } } })
        expect(await findMemberByEmail(h.db, 'buyer@example.com')).toMatchObject({ profile: { name: 'Typed by someone' }, emailVerifiedAt: null })
      })

      it('gives ten calls at once one member, created once', async () => {
        await install(ALL)
        const { result, error } = await call({ action: 'ensureTogether', email: 'rush@example.com' })
        expect(error).toBeUndefined()
        const all = result as Ensured[]
        expect(all).toHaveLength(10)
        expect(new Set(all.map((entry) => entry.member.id)).size).toBe(1)
        expect(all.filter((entry) => entry.created)).toHaveLength(1)
        const { rows } = await h.db<{ id: string }>`select id from members where email_normalized = ${'rush@example.com'}`
        expect(rows).toHaveLength(1)
        const { rows: audit } = await h.db<{ id: string }>`select id from audit_events where action = 'member.create'`
        expect(audit).toHaveLength(1)
      })

      it('lets the address index decide between inserts that really overlap', async () => {
        // Calls through one worker reach the host one after another; called
        // directly, all ten look the address up before any of them inserts.
        const all = await Promise.all(
          Array.from({ length: 10 }, () => ensureMember(h.db, { email: 'overlap@example.com', tags: ['vip'], source: PLUGIN_ID })),
        )
        expect(new Set(all.map((entry) => entry.member.id)).size).toBe(1)
        expect(all.filter((entry) => entry.created)).toHaveLength(1)
        const { rows } = await h.db<{ tag: string }>`select tag from member_tags where member_id = ${all[0]!.member.id}`
        expect(rows).toEqual([{ tag: 'vip' }])
      })

      it('leaves a suspended member suspended', async () => {
        await install(ALL)
        const ada = await member('ada@example.com')
        await setMemberSuspended(h.db, ada.id, true)
        const ensured = (await call({ action: 'ensure', email: 'ada@example.com' })).result as Ensured
        expect(ensured).toMatchObject({ created: false, member: { id: ada.id, status: 'suspended' } })
        expect((await findMemberByEmail(h.db, 'ada@example.com'))?.status).toBe('suspended')
      })

      it('gives a deleted member\'s address a fresh account', async () => {
        await install(ALL)
        const ada = await member('ada@example.com')
        await deleteMemberAsAdmin(h.db, ada.id)
        const ensured = (await call({ action: 'ensure', email: 'ada@example.com' })).result as Ensured
        expect(ensured.created).toBe(true)
        expect(ensured.member.id).not.toBe(ada.id)
      })

      it('refuses an invalid address and tags it may not give', async () => {
        await install(ALL)
        expect((await call({ action: 'ensure', email: 'not an address' })).error).toContain('not a valid email')
        expect((await call({ action: 'ensure', email: 'a@example.com', tags: ['instatic:locked'] })).error).toBeDefined()
        expect(await findMemberByEmail(h.db, 'a@example.com')).toBeNull()
        const { rows } = await h.db<{ id: string }>`select id from members`
        expect(rows).toEqual([])
      })

      it('needs members.write and members.read, and members.tags for tags', async () => {
        const source = `export function activate(api) {
          api.cms.routes.public.post('/ensure', async (ctx) => {
            try { return { result: await api.cms.members.ensure(ctx.body) } }
            catch (err) { return { error: String(err && err.message ? err.message : err) } }
          })
        }`
        const ensureAs = async (id: string, body: Record<string, unknown>) =>
          (await (await visit(`/_instatic/plugins/${id}/ensure`, { method: 'POST', json: body })).json()) as { error?: string; result?: unknown }
        await install(['cms.routes', 'cms.routes.public', 'members.read'], source, 'acme.reader')
        expect((await ensureAs('acme.reader', { email: 'a@example.com' })).error).toContain('members.write')
        await install(['cms.routes', 'cms.routes.public', 'members.write'], source, 'acme.writer')
        expect((await ensureAs('acme.writer', { email: 'a@example.com' })).error).toContain('members.read')
        await install(['cms.routes', 'cms.routes.public', 'members.read', 'members.write'], source, 'acme.both')
        expect((await ensureAs('acme.both', { email: 'a@example.com', tags: ['pro'] })).error).toContain('members.tags')
        expect(await findMemberByEmail(h.db, 'a@example.com')).toBeNull()
        expect((await ensureAs('acme.both', { email: 'a@example.com' })).result).toMatchObject({ created: true })
      })
    })

    it('says whether the site can email members, and why not', async () => {
      await install(ALL)
      const previous = process.env.NODE_ENV
      // Outside production a site with no connector captures mail, so turn that off.
      process.env.NODE_ENV = 'production'
      try {
        expect((await call({ action: 'emailStatus' })).result).toEqual({
          canEmail: false,
          reasons: ['public_address_missing', 'mail_not_configured', 'invite_page_missing', 'sign_in_page_missing'],
        })
      } finally {
        process.env.NODE_ENV = previous
      }
      configurePublicOrigins(['http://localhost'])
      await saveMemberSettings(h.db, { ...DEFAULT_MEMBER_SETTINGS, pages: await publishMemberPages(h.db, { invite: '/invitation' }) })
      // No connector outside production: mail is captured for the admin, not sent.
      expect((await call({ action: 'emailStatus' })).result).toEqual({
        canEmail: false,
        reasons: ['mail_captured_not_sent', 'sign_in_page_missing'],
      })
      await saveMemberSettings(h.db, {
        ...DEFAULT_MEMBER_SETTINGS,
        pages: await publishMemberPages(h.db, { invite: '/invitation', reset: '/reset' }),
      })
      expect((await call({ action: 'emailStatus' })).result).toEqual({ canEmail: false, reasons: ['mail_captured_not_sent'] })
      const { rows } = await h.db<{ id: string }>`select id from users limit 1`
      const connector = await createMailConnector(
        h.db,
        { kind: 'smtp', label: 'Relay', config: { host: 'smtp.example.com', port: 587, username: 'mailer' }, secret: 's' },
        rows[0]!.id,
      )
      await saveMailDefaults(
        h.db,
        { defaultConnectorId: connector.id, fromAddress: 'hello@example.com', fromName: 'Example', replyTo: '' },
        rows[0]!.id,
      )
      expect((await call({ action: 'emailStatus' })).result).toEqual({ canEmail: true, reasons: [] })
    })

    it('needs the permission for each call', async () => {
      // The same plugin without its hooks, holding only the right to read members.
      const source = PLUGIN_SOURCE.replace(/const heard = \[\][\s\S]*?api\.cms\.routes\.public\.get\('\/heard'[^\n]*\n/, '')
      await install(['cms.routes', 'cms.routes.public', 'members.read'], source)
      const ada = await member('ada@example.com')
      expect((await call({ action: 'get', memberId: ada.id })).result).toMatchObject({ email: 'ada@example.com' })
      expect((await call({ action: 'grant', memberId: ada.id, tag: 'gold' })).error).toContain('members.tags')
      expect((await call({ action: 'invite', email: 'new@example.com' })).error).toContain('members.write')
      expect((await call({ action: 'emailStatus' })).error).toContain('members.write')
      expect(await listActiveMemberTags(h.db, ada.id)).toEqual([])
    })
  })

  describe('member data export', () => {
    const DECLARES = { memberDataExport: true }
    const exporting = (title: string) => `export function activate(api) {
      api.cms.members.exportProvider(async (memberId) => ({ title: ${JSON.stringify(title)}, data: { memberId, orders: [{ id: 'o1', total: 12 }] } }))
    }`
    type Section = { plugin: string; included: boolean; reason?: string; title?: string; data?: unknown }
    const exportOf = async (cookie: string) => {
      const res = await visit('/_instatic/members/export', { cookie })
      expect(res.status).toBe(200)
      return (await res.json()) as { account: { email: string }; plugins: Section[] }
    }
    const sectionOf = (plugins: Section[], id: string) => plugins.find((section) => section.plugin === id)

    beforeEach(() => resetMemberLimits())

    it('carries each plugin section, and lists a plugin that failed instead of dropping it', async () => {
      await install(['members.read'], exporting('Orders'), 'acme.shop', DECLARES)
      await install(
        ['members.read'],
        `export function activate(api) {
           api.cms.members.exportProvider(async () => { throw new Error('database unavailable') })
         }`,
        'acme.broken',
        DECLARES,
      )
      await install(['members.read'], `export function activate(api) {
           api.cms.members.exportProvider(async () => 'not a section')
         }`, 'acme.odd', DECLARES)
      await install(['members.read'], `export function activate(api) {
           let deep = 'bottom'
           for (let i = 0; i < 100; i++) deep = { deeper: deep }
           api.cms.members.exportProvider(async () => ({ data: deep }))
         }`, 'acme.deep', DECLARES)
      await install(['members.read'], `export function activate(api) {
           api.cms.members.exportProvider(async () => ({ title: 'Nothing kept' }))
         }`, 'acme.empty', DECLARES)
      const ada = await member('ada@example.com')

      const mine = await exportOf(ada.cookie)
      expect(mine.account.email).toBe('ada@example.com')
      expect(sectionOf(mine.plugins, 'acme.shop')).toEqual({
        plugin: 'acme.shop',
        name: 'Club',
        included: true,
        title: 'Orders',
        data: { memberId: ada.id, orders: [{ id: 'o1', total: 12 }] },
      })
      expect(sectionOf(mine.plugins, 'acme.broken')).toMatchObject({ included: false, reason: expect.stringContaining('Could not be included') })
      expect(sectionOf(mine.plugins, 'acme.odd')).toMatchObject({ included: false, reason: expect.stringContaining('{ title, data }') })
      expect(sectionOf(mine.plugins, 'acme.deep')).toMatchObject({ included: false, reason: expect.stringContaining('64 levels') })
      expect(sectionOf(mine.plugins, 'acme.empty')).toMatchObject({ included: true, title: 'Nothing kept', data: null })

      // The admin's download is the same export, saved under the member's id, and audited.
      const admin = await h.cms(`/admin/api/cms/members/${ada.id}/export`, { cookie: owner })
      expect(admin.status).toBe(200)
      expect(admin.headers.get('content-disposition')).toBe(`attachment; filename="member-${ada.id}-data.json"`)
      const theirs = (await admin.json()) as { plugins: unknown[] }
      expect(theirs.plugins).toEqual(mine.plugins)
      const { rows } = await h.db<{ target_id: string }>`select target_id from audit_events where action = 'member.export'`
      expect(rows).toEqual([{ target_id: ada.id }])
    })

    it('lists a declaring plugin that is not running, or did not offer its section', async () => {
      await install(['members.read'], exporting('Orders'), 'acme.sleepy', DECLARES)
      await install(['members.read'], 'export function activate() {}', 'acme.quiet', DECLARES)
      const off = await h.cms('/admin/api/cms/plugins/acme.sleepy', { method: 'PATCH', cookie: await h.stepUp(owner), json: { enabled: false } })
      expect(off.status).toBeLessThan(300)
      const ada = await member('ada@example.com')
      const mine = await exportOf(ada.cookie)
      expect(sectionOf(mine.plugins, 'acme.sleepy')).toMatchObject({ included: false, reason: expect.stringContaining('not running') })
      expect(sectionOf(mine.plugins, 'acme.quiet')).toMatchObject({ included: false, reason: expect.stringContaining('did not offer') })
    })

    it('lists a plugin that misses the deadline as timed out', async () => {
      await install(['members.read'], `export function activate(api) {
           api.cms.members.exportProvider(async () => {
             const end = Date.now() + 1500
             while (Date.now() < end) {}
             return { data: 'late' }
           })
         }`, 'acme.slow', DECLARES)
      const created = await createMember(h.db, { email: 'ada@example.com', passwordHash: 'x', profile: {}, verified: true })
      const exported = await exportMemberDataWithPlugins(h.db, created!, 200)
      expect(sectionOf(exported.plugins as Section[], 'acme.slow')).toMatchObject({ included: false, reason: 'Could not be included: timed out' })
    })

    it('runs one export per member at a time', async () => {
      await install(['members.read'], exporting('Orders'), 'acme.shop', DECLARES)
      const created = await createMember(h.db, { email: 'ada@example.com', passwordHash: 'x', profile: {}, verified: true })
      const first = exportMemberDataWithPlugins(h.db, created!)
      expect(exportMemberDataWithPlugins(h.db, created!)).toBe(first)
      await first
    })

    it('limits an administrator to 30 downloads an hour, and refuses one started from another site', async () => {
      const ada = await member('ada@example.com')
      // Set after construction: the test DOM's Request drops a Sec- header given in its init.
      const crossSite = new Request(`${ORIGIN}/admin/api/cms/members/${ada.id}/export`)
      crossSite.headers.set('cookie', owner)
      crossSite.headers.set('sec-fetch-site', 'cross-site')
      expect((await handleCmsRequest(crossSite, h.db, { uploadsDir })).status).toBe(403)
      for (let i = 0; i < 30; i++) expect((await h.cms(`/admin/api/cms/members/${ada.id}/export`, { cookie: owner })).status).toBe(200)
      const limited = await h.cms(`/admin/api/cms/members/${ada.id}/export`, { cookie: owner })
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    })

    it('lists a plugin whose stored manifest no longer reads, when it may read members', async () => {
      await install(['members.read'], exporting('Orders'), 'acme.garbled', DECLARES)
      await h.db`update installed_plugins set manifest_json = ${'{"not":"a manifest"}'} where id = ${'acme.garbled'}`
      const ada = await member('ada@example.com')
      const mine = await exportOf(ada.cookie)
      expect(sectionOf(mine.plugins, 'acme.garbled')).toMatchObject({
        included: false,
        reason: 'Could not be included: its manifest could not be read',
      })
    })

    it('measures a section as the UTF-8 bytes of its JSON', () => {
      const samples: unknown[] = [
        { ascii: 'plain text', n: 12, ok: true, none: null, list: [1, 2.5, -3] },
        { multibyte: 'žluťoučký kůň €, 漢字, 🦊🦊' },
        { control: 'line\nbreak\ttab \u0001\u001f "quoted" back\\slash' },
        ['\ud800 lone surrogate', '\udc00'],
        'x'.repeat(5000),
      ]
      for (const sample of samples) {
        const exact = Buffer.byteLength(JSON.stringify(sample), 'utf8')
        expect(fitsJson(sample, exact)).toBe(true)
        expect(fitsJson(sample, exact - 1)).not.toBe(true)
      }
    })

    it('limits the member to 3 downloads an hour, and refuses one started from another site', async () => {
      const ada = await member('ada@example.com')
      const crossSite = new Request(`${ORIGIN}/_instatic/members/export`)
      crossSite.headers.set('cookie', ada.cookie)
      crossSite.headers.set('sec-fetch-site', 'cross-site')
      expect((await handleServerRequest(crossSite, { db: h.db, uploadsDir })).status).toBe(403)
      for (let i = 0; i < 3; i++) expect((await visit('/_instatic/members/export', { cookie: ada.cookie })).status).toBe(200)
      const limited = await visit('/_instatic/members/export', { cookie: ada.cookie })
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    })

    it('cannot be offered without members.read, without declaring it, or twice', async () => {
      const refused = await install(['cms.routes', 'cms.routes.public'], 'export function activate() {}', 'acme.nosy', DECLARES)
      // The manifest itself is refused: declaring an export needs members.read.
      expect(refused.status).toBe(400)
      await install(
        ['cms.routes', 'cms.routes.public', 'members.read'],
        `export function activate(api) {
           api.cms.routes.public.get('/before', () => ({ ok: true }))
           api.cms.members.exportProvider(async () => ({ data: {} }))
         }`,
        'acme.undeclared',
      )
      // Not declared: the registration is refused, which fails activation.
      expect((await visit('/_instatic/plugins/acme.undeclared/before')).status).toBe(404)
      await install(
        ['cms.routes', 'cms.routes.public', 'members.read'],
        `export function activate(api) {
           api.cms.members.exportProvider(async () => ({ data: 1 }))
           let second = null
           try { api.cms.members.exportProvider(async () => ({ data: 2 })) } catch (err) { second = String(err.message) }
           api.cms.routes.public.get('/second', () => ({ second }))
         }`,
        'acme.twice',
        DECLARES,
      )
      expect(await (await visit('/_instatic/plugins/acme.twice/second')).json()).toEqual({
        second: 'This plugin already registered its member export provider',
      })
    })
  })

  describe('deletedSince', () => {
    const SOURCE = `export function activate(api) {
      api.cms.routes.public.post('/deleted', async (ctx) => {
        try { return await api.cms.members.deletedSince(ctx.body.cursor ?? null, ctx.body.limit ? { limit: ctx.body.limit } : {}) }
        catch (err) { return { error: String(err.message) } }
      })
    }`
    const page = async (cursor: string | null, limit?: number) =>
      (await (await visit('/_instatic/plugins/acme.erase/deleted', { method: 'POST', json: { cursor, limit } })).json()) as {
        ids: string[]
        nextCursor: string | null
        error?: string
      }

    it('pages through deletions in order, ties included, and stays put when nothing is new', async () => {
      await install(['cms.routes', 'cms.routes.public', 'members.read'], SOURCE, 'acme.erase')
      const ids: string[] = []
      for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
        const created = await createMember(h.db, { email, passwordHash: null, profile: {}, verified: false })
        await deleteMemberAsAdmin(h.db, created!.id)
        ids.push(created!.id)
      }
      // Three deleted in the same instant, one later.
      const same = '2026-11-20T10:00:00.000Z'
      for (const id of ids.slice(0, 3)) await h.db`update members set deleted_at = ${same} where id = ${id}`
      await h.db`update members set deleted_at = ${'2026-11-20T10:00:05.000Z'} where id = ${ids[3]!}`
      // Within one instant the order follows the database's own id ordering,
      // so the tied ids are compared as a set: each comes once, before the later one.
      const tied = new Set(ids.slice(0, 3))

      const first = await page(null, 2)
      const second = await page(first.nextCursor, 2)
      expect(first.ids).toHaveLength(2)
      expect(second.ids).toHaveLength(2)
      const pagedTies = [...first.ids, second.ids[0]!]
      expect(new Set(pagedTies)).toEqual(tied)
      expect(pagedTies).toHaveLength(3)
      expect(second.ids[1]).toBe(ids[3])
      const empty = await page(second.nextCursor, 2)
      expect(empty).toEqual({ ids: [], nextCursor: second.nextCursor })
      expect((await page('bm90LWEtY3Vyc29y')).error).toContain('not a cursor')
    })
  })

  describe('member events', () => {

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

    it('tell a plugin that may read members about a deletion, by the member and by an admin', async () => {
      await install(ALL)
      // No password: a member who signed in moments ago may delete without one.
      const created = await createMember(h.db, { email: 'ada@example.com', passwordHash: null, profile: {}, verified: true })
      const session = await createMemberSession(h.db, created!.id, { ipAddress: null, userAgent: null })
      const ada = { id: created!.id, cookie: `instatic_member=${session.token}` }
      const bea = await member('bea@example.com')
      const own = await visit('/_instatic/members/delete', { method: 'POST', cookie: ada.cookie, json: {} })
      expect(own.status).toBe(200)
      expect((await h.cms(`/admin/api/cms/members/${bea.id}`, { method: 'DELETE', cookie: await h.stepUp(owner) })).status).toBe(200)
      await settle()
      const deleted = (await heard()).filter((entry) => entry.event === 'member.deleted')
      expect(deleted).toEqual([
        { event: 'member.deleted', memberId: ada.id },
        { event: 'member.deleted', memberId: bea.id },
      ])
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
