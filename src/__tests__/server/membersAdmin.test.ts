/**
 * The members admin API: who may call it, and what each call does to a
 * member.
 *
 * The capability harness sets up one owner per database, so this file runs
 * on SQLite. The queries behind it are exercised on Postgres too by the
 * `listMembersForAdmin` cases in `members.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { MemberApp, MemberDetail, MemberListItem, MemberListResponse, MemberSettingsResponse } from '@core/members'
import { DEFAULT_MEMBER_SETTINGS } from '@core/members'
import { nowIso } from '@core/utils/isoDate'
import { resetPublicOrigins } from '../../../server/auth/security'
import { createMemberApp } from '../../../server/members/apps/store'
import { flushMemberMail } from '../../../server/members/mail'
import { resetMemberLimits } from '../../../server/members/limits'
import {
  createMember,
  findMemberByEmail,
  grantMemberTag,
  listActiveMemberTags,
  listMemberEvents,
  saveMemberSettings,
} from '../../../server/members/repository'
import { createMemberSession, findMemberSession, listMemberSessions } from '../../../server/members/sessions'
import {
  createCapabilityTestHarness,
  expectForbidden,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { publishMemberPages } from '../helpers/memberPages'

const BASE = '/admin/api/cms/members'

describe('members admin API', () => {
  let h: CapabilityTestHarness
  let owner: string

  beforeEach(async () => {
    h = await createCapabilityTestHarness()
    resetMemberLimits()
    resetPublicOrigins()
    owner = await h.setupOwner()
  })

  afterEach(async () => {
    await flushMemberMail()
    resetPublicOrigins()
    await h.cleanup()
  })

  async function member(email: string, options: { name?: string; tags?: string[]; password?: boolean } = {}) {
    const created = await createMember(h.db, {
      email,
      passwordHash: options.password === false ? null : 'x',
      profile: options.name ? { name: options.name } : {},
      verified: options.password !== false,
    })
    for (const tag of options.tags ?? []) {
      await grantMemberTag(h.db, { memberId: created!.id, tag, source: 'admin', expiresAt: null })
    }
    return created!
  }

  const list = async (query = '', cookie = owner) =>
    readJson<MemberListResponse>(await h.cms(`${BASE}${query}`, { cookie }))
  const detailOf = async (id: string) =>
    (await readJson<{ detail: MemberDetail }>(await h.cms(`${BASE}/${id}`, { cookie: owner }))).detail

  describe('who may call it', () => {
    it('refuses a user without a members capability, on every route', async () => {
      const target = await member('ada@example.com')
      const editor = await h.createRoleUser({ name: 'Editor', slug: 'editor', capabilities: ['site.read'] })
      const calls: Array<[string, string, unknown?]> = [
        ['GET', BASE],
        ['GET', `${BASE}/settings`],
        ['GET', `${BASE}/${target.id}`],
        ['POST', `${BASE}/invite`, { email: 'new@example.com' }],
        ['PUT', `${BASE}/settings`, DEFAULT_MEMBER_SETTINGS],
        ['POST', `${BASE}/${target.id}/suspend`],
        ['POST', `${BASE}/${target.id}/unsuspend`],
        ['POST', `${BASE}/${target.id}/sign-out`],
        ['POST', `${BASE}/${target.id}/tags`, { tag: 'pro' }],
        ['DELETE', `${BASE}/${target.id}/tags`, { tag: 'pro', source: 'admin' }],
        ['DELETE', `${BASE}/${target.id}/apps/some-grant`],
        ['DELETE', `${BASE}/${target.id}`],
      ]
      for (const [method, path, json] of calls) {
        await expectForbidden(await h.cms(path, { method, cookie: editor.cookie, ...(json ? { json } : {}) }))
      }
    })

    it('lets a reader look but not change anything', async () => {
      const target = await member('ada@example.com')
      const reader = await h.createRoleUser({ name: 'Viewer', slug: 'viewer', capabilities: ['members.read'] })
      expect((await list('', reader.cookie)).members).toHaveLength(1)
      await expectForbidden(await h.cms(`${BASE}/${target.id}/suspend`, { method: 'POST', cookie: reader.cookie }))
      await expectForbidden(await h.cms(`${BASE}/${target.id}/tags`, { method: 'POST', cookie: reader.cookie, json: { tag: 'pro' } }))
      expect((await findMemberByEmail(h.db, 'ada@example.com'))?.status).toBe('active')
    })

    it('asks for the password again before deleting a member or changing the settings', async () => {
      const target = await member('ada@example.com')
      const manager = await h.createRoleUser({ name: 'Manager', slug: 'manager', capabilities: ['members.manage'] })
      await expectStepUpRequired(await h.cms(`${BASE}/${target.id}`, { method: 'DELETE', cookie: manager.cookie }))
      await expectStepUpRequired(
        await h.cms(`${BASE}/settings`, { method: 'PUT', cookie: manager.cookie, json: { ...DEFAULT_MEMBER_SETTINGS, signupMode: 'open' } }),
      )
      expect(await findMemberByEmail(h.db, 'ada@example.com')).not.toBeNull()
      // A manager without the read capability can still list: managing implies seeing.
      expect((await list('', manager.cookie)).members).toHaveLength(1)
    })
  })

  describe('list', () => {
    it('searches by address and name, filters by status and tag, and counts everyone', async () => {
      await member('ada@example.com', { name: 'Ada Lovelace', tags: ['pro'] })
      await member('grace@example.com', { name: 'Grace Hopper' })
      await member('pending@example.com', { password: false })
      const suspended = await member('linus@example.com')
      await h.cms(`${BASE}/${suspended.id}/suspend`, { method: 'POST', cookie: owner })

      const all = await list()
      expect(all.counts).toEqual({ all: 4, active: 2, pending: 1, suspended: 1 })
      expect(all.tags).toEqual([{ tag: 'pro', count: 1 }])
      expect(all.matching).toBe(4)

      expect((await list('?q=GRACE')).members.map((m) => m.email)).toEqual(['grace@example.com'])
      expect((await list('?q=lovelace')).members.map((m) => m.email)).toEqual(['ada@example.com'])
      // A wildcard is plain text, not "match everything".
      expect((await list('?q=%25')).matching).toBe(4)
      expect((await list('?status=pending')).members.map((m) => m.email)).toEqual(['pending@example.com'])
      expect((await list('?status=suspended')).members.map((m) => m.email)).toEqual(['linus@example.com'])
      expect((await list('?status=active')).matching).toBe(2)
      const pro = await list('?tag=pro')
      expect(pro.members.map((m) => m.email)).toEqual(['ada@example.com'])
      expect(pro.members[0]).toMatchObject({ name: 'Ada Lovelace', status: 'active', tags: ['pro'] })
      expect(pro.counts.all).toBe(4)
    })

    it('leaves an expired tag out of the list, the filter and the counts', async () => {
      const ada = await member('ada@example.com')
      await grantMemberTag(h.db, { memberId: ada.id, tag: 'trial', source: 'admin', expiresAt: new Date(Date.now() - 1000).toISOString() })
      const result = await list('?tag=trial')
      expect(result.matching).toBe(0)
      expect(result.tags).toEqual([])
      expect((await detailOf(ada.id)).grants).toMatchObject([{ tag: 'trial', expired: true }])
    })
  })

  describe('one member', () => {
    it('suspends: sessions end for good, and restoring lets the member sign in again', async () => {
      const ada = await member('ada@example.com')
      const session = await createMemberSession(h.db, ada.id, { ipAddress: null, userAgent: null })
      expect(await findMemberSession(h.db, session.token)).not.toBeNull()

      const suspended = await readJson<{ detail: MemberDetail }>(await h.cms(`${BASE}/${ada.id}/suspend`, { method: 'POST', cookie: owner }))
      expect(suspended.detail.member.status).toBe('suspended')
      expect(await findMemberSession(h.db, session.token)).toBeNull()

      await h.cms(`${BASE}/${ada.id}/unsuspend`, { method: 'POST', cookie: owner })
      expect((await detailOf(ada.id)).member.status).toBe('active')
      // Restoring does not revive what was open before: the member signs in again.
      expect(await findMemberSession(h.db, session.token)).toBeNull()
      expect(await listMemberSessions(h.db, ada.id)).toEqual([])
    })

    it('signs a member out everywhere', async () => {
      const ada = await member('ada@example.com')
      await createMemberSession(h.db, ada.id, { ipAddress: null, userAgent: null })
      await createMemberSession(h.db, ada.id, { ipAddress: null, userAgent: null })
      expect((await detailOf(ada.id)).sessions).toHaveLength(2)
      await h.cms(`${BASE}/${ada.id}/sign-out`, { method: 'POST', cookie: owner })
      expect(await listMemberSessions(h.db, ada.id)).toEqual([])
    })

    it('grants a tag with an end date, refuses a reserved or past one, and withdraws only the named source', async () => {
      const ada = await member('ada@example.com')
      await grantMemberTag(h.db, { memberId: ada.id, tag: 'pro', source: 'acme.shop', expiresAt: null })
      const later = new Date(Date.now() + 86_400_000).toISOString()

      const granted = await h.cms(`${BASE}/${ada.id}/tags`, { method: 'POST', cookie: owner, json: { tag: 'pro', expiresAt: later } })
      expect(granted.status).toBe(200)
      expect((await detailOf(ada.id)).grants.map((grant) => `${grant.tag}:${grant.source}`).sort()).toEqual(['pro:acme.shop', 'pro:admin'])

      const reserved = await h.cms(`${BASE}/${ada.id}/tags`, { method: 'POST', cookie: owner, json: { tag: 'instatic:locked' } })
      expect(reserved.status).toBe(400)
      const past = await h.cms(`${BASE}/${ada.id}/tags`, { method: 'POST', cookie: owner, json: { tag: 'old', expiresAt: '2020-01-01T00:00:00Z' } })
      expect(past.status).toBe(400)

      await h.cms(`${BASE}/${ada.id}/tags`, { method: 'DELETE', cookie: owner, json: { tag: 'pro', source: 'admin' } })
      expect((await detailOf(ada.id)).grants.map((grant) => grant.source)).toEqual(['acme.shop'])
      expect(await listActiveMemberTags(h.db, ada.id)).toEqual(['pro'])
    })

    it('deletes for good: the address is free again and the audit keeps who it was', async () => {
      const ada = await member('ada@example.com', { tags: ['pro'] })
      const res = await h.cms(`${BASE}/${ada.id}`, { method: 'DELETE', cookie: owner })
      expect(res.status).toBe(200)
      expect(await findMemberByEmail(h.db, 'ada@example.com')).toBeNull()
      expect((await list()).counts.all).toBe(0)
      expect((await h.cms(`${BASE}/${ada.id}`, { cookie: owner })).status).toBe(404)

      const { events } = await readJson<{ events: Array<{ action: string; metadata: Record<string, unknown> }> }>(
        await h.cms('/admin/api/cms/audit', { cookie: owner }),
      )
      expect(events.find((event) => event.action === 'member.delete')?.metadata.email).toBe('ada@example.com')
    })

    it('answers 404 for a member that does not exist, on every per-member route', async () => {
      for (const [method, path, json] of [
        ['GET', `${BASE}/nope`],
        ['POST', `${BASE}/nope/suspend`],
        ['POST', `${BASE}/nope/sign-out`],
        ['POST', `${BASE}/nope/tags`, { tag: 'pro' }],
        ['DELETE', `${BASE}/nope`],
      ] as Array<[string, string, unknown?]>) {
        expect((await h.cms(path, { method, cookie: owner, ...(json ? { json } : {}) })).status).toBe(404)
      }
    })
  })

  describe('connected apps', () => {
    /** One live approval of a registered app by a member, as the approval page leaves it. */
    async function connect(memberId: string, name = 'Instatic Desktop'): Promise<string> {
      const app = await createMemberApp(h.db, {
        name,
        redirectUris: ['http://127.0.0.1/callback'],
        scopes: ['profile'],
        createdByUserId: null,
      })
      const grantId = `grant-${memberId}-${app.id}`
      await h.db`
        insert into member_app_grants (id, member_id, app_id, scope, created_at, expires_at)
        values (${grantId}, ${memberId}, ${app.id}, ${'profile'}, ${nowIso()}, ${new Date(Date.now() + 86_400_000).toISOString()})
      `
      return grantId
    }
    const disconnect = (memberId: string, grantId: string, cookie = owner) =>
      h.cms(`${BASE}/${memberId}/apps/${grantId}`, { method: 'DELETE', cookie })

    it('lists the apps a member is signed in to, and none for a member who has not', async () => {
      const ada = await member('ada@example.com')
      const bob = await member('bob@example.com')
      const grantId = await connect(ada.id)
      const apps = (await detailOf(ada.id)).connectedApps
      expect(apps).toHaveLength(1)
      expect(apps[0]).toMatchObject({ id: grantId, name: 'Instatic Desktop', lastUsedAt: null })
      expect(Number.isNaN(Date.parse(apps[0]!.connectedAt))).toBe(false)
      expect((await detailOf(bob.id)).connectedApps).toEqual([])
    })

    it('disconnects an app once: it leaves the detail, the member and the audit record it, and a second try answers 404', async () => {
      const ada = await member('ada@example.com')
      const grantId = await connect(ada.id)
      const res = await disconnect(ada.id, grantId)
      expect(res.status).toBe(200)
      expect((await readJson<{ detail: MemberDetail }>(res)).detail.connectedApps).toEqual([])
      expect((await detailOf(ada.id)).connectedApps).toEqual([])
      expect((await listMemberEvents(h.db, ada.id)).map((event) => event.kind)).toContain('app_disconnected_by_admin')

      const { events } = await readJson<{ events: Array<{ action: string; targetId: string | null; metadata: Record<string, unknown> }> }>(
        await h.cms('/admin/api/cms/audit', { cookie: owner }),
      )
      const recorded = events.filter((event) => event.action === 'member.app.disconnect')
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.metadata).toMatchObject({ email: 'ada@example.com', app: 'Instatic Desktop' })

      const again = await disconnect(ada.id, grantId)
      expect(again.status).toBe(404)
      expect(typeof (await readJson<{ error: string }>(again)).error).toBe('string')
      expect((await listMemberEvents(h.db, ada.id)).filter((event) => event.kind === 'app_disconnected_by_admin')).toHaveLength(1)
    })

    it('refuses a user who cannot manage members, and needs no second password from one who can', async () => {
      const ada = await member('ada@example.com')
      const grantId = await connect(ada.id)
      const reader = await h.createRoleUser({ name: 'Viewer', slug: 'viewer', capabilities: ['members.read'] })
      await expectForbidden(await disconnect(ada.id, grantId, reader.cookie))
      expect((await detailOf(ada.id)).connectedApps).toHaveLength(1)

      const manager = await h.createRoleUser({ name: 'Manager', slug: 'manager', capabilities: ['members.manage'] })
      expect((await disconnect(ada.id, grantId, manager.cookie)).status).toBe(200)
      expect((await detailOf(ada.id)).connectedApps).toEqual([])
    })

    it('answers 404 for an approval that belongs to another member, and leaves it connected', async () => {
      const ada = await member('ada@example.com')
      const bob = await member('bob@example.com')
      const grantId = await connect(ada.id)
      expect((await disconnect(bob.id, grantId)).status).toBe(404)
      expect((await disconnect('nope', grantId)).status).toBe(404)
      expect((await detailOf(ada.id)).connectedApps.map((app) => app.id)).toEqual([grantId])
      expect((await listMemberEvents(h.db, bob.id)).map((event) => event.kind)).not.toContain('app_disconnected_by_admin')
    })

    it('does not get in the way of the app registry routes', async () => {
      const ada = await member('ada@example.com')
      await connect(ada.id)
      const registry = await readJson<{ apps: MemberApp[] }>(await h.cms(`${BASE}/apps`, { cookie: owner }))
      expect(registry.apps).toHaveLength(1)
      // Removing the registered app is still the registry route, not a disconnect of a member called "apps".
      expect((await h.cms(`${BASE}/apps/${registry.apps[0]!.id}`, { method: 'DELETE', cookie: owner })).status).toBe(200)
      expect((await detailOf(ada.id)).connectedApps).toEqual([])
    })
  })

  describe('invitations', () => {
    // An invitation opens a page of the site; the owner's is set here.
    beforeEach(async () => {
      await saveMemberSettings(h.db, { ...DEFAULT_MEMBER_SETTINGS, pages: await publishMemberPages(h.db, { invite: '/invitation' }) })
    })

    it('are off, with nobody created, while the site has no invitation page', async () => {
      await saveMemberSettings(h.db, DEFAULT_MEMBER_SETTINGS)
      for (const delivery of ['email', 'link']) {
        const res = await invite({ email: 'early@example.com', delivery })
        expect(res.status).toBe(409)
        expect((await readJson<{ error: string }>(res)).error).toContain('no page that accepts an invitation')
      }
      expect((await list()).counts.all).toBe(0)
      expect(await inviteMails()).toHaveLength(0)
    })

    const invite = (json: unknown) => h.cms(`${BASE}/invite`, { method: 'POST', cookie: owner, json })
    const inviteMails = async () => {
      await flushMemberMail()
      const { rows } = await h.db<{ to_address: string; body_text: string | null }>`
        select to_address, body_text from mail_outbox where kind = 'member.invite' order by id
      `
      return rows
    }

    it('creates an invited member with their tags and emails a link', async () => {
      const res = await invite({ email: 'New@Example.com', tags: ['student'] })
      expect(res.status).toBe(201)
      const created = await findMemberByEmail(h.db, 'new@example.com')
      expect(created).toMatchObject({ passwordHash: null, emailVerifiedAt: null, status: 'active' })
      expect(await listActiveMemberTags(h.db, created!.id)).toEqual(['student'])
      expect((await list('?status=pending')).members.map((m) => m.email)).toEqual(['New@Example.com'])

      const mails = await inviteMails()
      expect(mails).toHaveLength(1)
      expect(mails[0].to_address).toBe('New@Example.com')
      expect(mails[0].body_text).toContain('token=')
    })

    it('sends a fresh link for a pending invitation and refuses an address that has an account', async () => {
      await invite({ email: 'new@example.com' })
      const again = await invite({ email: 'new@example.com' })
      expect(again.status).toBe(200)
      expect((await readJson<{ outcome: string }>(again)).outcome).toBe('resent')
      expect((await list()).counts.all).toBe(1)

      await member('ada@example.com')
      const taken = await invite({ email: 'ada@example.com' })
      expect(taken.status).toBe(409)
      expect(await inviteMails()).toHaveLength(2)
    })

    it('hands the link to the admin when asked, and emails nothing', async () => {
      const res = await invite({ email: 'byhand@example.com', tags: ['student'], delivery: 'link' })
      expect(res.status).toBe(201)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await readJson<{ member: MemberListItem; link?: string }>(res)
      expect(body.member).toMatchObject({ email: 'byhand@example.com', status: 'pending', tags: ['student'] })
      expect(body.link).toMatch(/^http:\/\/localhost\/invitation\?token=[\w-]+$/)
      expect(await inviteMails()).toHaveLength(0)


      // Asking again makes a fresh link, and the first one stops working.
      const again = await readJson<{ link?: string; outcome: string }>(await invite({ email: 'byhand@example.com', delivery: 'link' }))
      expect(again.outcome).toBe('resent')
      expect(again.link).not.toBe(body.link)

      const audit = await readJson<{ events: Array<{ action: string; metadata?: Record<string, unknown> }> }>(await h.cms('/admin/api/cms/audit', { cookie: owner }))
      expect(audit.events.find((event) => event.action === 'member.invite')?.metadata).toMatchObject({ delivery: 'link' })
    })

    it('asks for the password again before handing over a link, but not before emailing one', async () => {
      const manager = await h.createRoleUser({ name: 'Members', slug: 'members-manager', capabilities: ['members.read', 'members.manage'] })
      const call = (json: unknown, cookie: string) => h.cms(`${BASE}/invite`, { method: 'POST', cookie, json })
      const asked = await call({ email: 'step@example.com', delivery: 'link' }, manager.cookie)
      expect(asked.status).toBe(401)
      expect((await readJson<{ error: string }>(asked)).error).toBe('step_up_required')
      expect((await list()).counts.all).toBe(0)
      expect((await call({ email: 'step@example.com' }, manager.cookie)).status).toBe(201)
      expect((await call({ email: 'step@example.com', delivery: 'link' }, await h.stepUp(manager.cookie))).status).toBe(200)
    })

    it('still invites by link on a live server with no outgoing email, where an emailed invitation is refused', async () => {
      const before = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      try {
        const settings = await readJson<MemberSettingsResponse>(await h.cms(`${BASE}/settings`, { cookie: owner }))
        expect(settings).toMatchObject({ mailAvailable: false, linkAvailable: true })
        const emailed = await invite({ email: 'live@example.com' })
        expect(emailed.status).toBe(409)
        expect((await list()).counts.all).toBe(0)
        const byHand = await invite({ email: 'live@example.com', delivery: 'link' })
        expect(byHand.status).toBe(201)
        expect((await readJson<{ link?: string }>(byHand)).link).toContain('token=')
      } finally {
        process.env.NODE_ENV = before
      }
    })

    it('refuses a malformed address and a reserved tag without creating anyone', async () => {
      expect((await invite({ email: 'not-an-address' })).status).toBe(400)
      expect((await invite({ email: 'ok@example.com', tags: ['instatic:locked'] })).status).toBe(400)
      expect((await list()).counts.all).toBe(0)
    })
  })

  describe('settings', () => {
    const save = (settings: unknown) => h.cms(`${BASE}/settings`, { method: 'PUT', cookie: owner, json: settings })

    it('starts closed, saves a change and records it', async () => {
      const before = await readJson<MemberSettingsResponse>(await h.cms(`${BASE}/settings`, { cookie: owner }))
      expect(before.settings.signupMode).toBe('closed')

      const next = {
        signupMode: 'open',
        profileFields: [
          { id: 'name', label: 'Name', type: 'text', required: true },
          { id: 'company', label: 'Company', type: 'text', required: false },
        ],
        pages: await publishMemberPages(h.db, { login: '/sign-in', reset: '/new-password' }),
      }
      expect((await save(next)).status).toBe(200)
      const after = await readJson<MemberSettingsResponse>(await h.cms(`${BASE}/settings`, { cookie: owner }))
      expect(after.settings).toEqual(next as MemberSettingsResponse['settings'])
      // The pickers get every page, with its live address.
      expect(after.pageOptions).toContainEqual({
        id: next.pages.login!, title: 'sign-in', path: '/sign-in', publishedPath: '/sign-in', formActions: [], membersOnly: false,
      })

      const { events } = await readJson<{ events: Array<{ action: string }> }>(await h.cms('/admin/api/cms/audit', { cookie: owner }))
      expect(events.some((event) => event.action === 'member.settings.update')).toBe(true)
    })

    it('refuses duplicate field ids, a field named like a form field, a page that does not exist and an unknown mode', async () => {
      const field = (id: string) => ({ id, label: 'L', type: 'text', required: false })
      const base = { signupMode: 'open', profileFields: [field('name')], pages: {} }
      expect((await save({ ...base, profileFields: [field('name'), field('name')] })).status).toBe(400)
      expect((await save({ ...base, profileFields: [field('password')] })).status).toBe(400)
      // A setting names a page of the site by id; an address, on this site or another, is not one.
      expect((await save({ ...base, pages: { login: '/sign-in' } })).status).toBe(400)
      expect((await save({ ...base, pages: { login: 'https://evil.example/' } })).status).toBe(400)
      expect((await save({ ...base, signupMode: 'everyone' })).status).toBe(400)
      const still = await readJson<MemberSettingsResponse>(await h.cms(`${BASE}/settings`, { cookie: owner }))
      expect(still.settings.signupMode).toBe('closed')
    })
  })

  describe('apps', () => {
    const APPS = `${BASE}/apps`
    const valid = { name: 'Instatic Desktop', redirectUris: ['http://127.0.0.1/callback'], scopes: ['profile', 'access'] }
    const apps = async (cookie = owner) => (await readJson<{ apps: MemberApp[] }>(await h.cms(APPS, { cookie }))).apps
    const create = (json: unknown, cookie = owner) => h.cms(APPS, { method: 'POST', cookie, json })

    it('starts with none', async () => {
      expect(await apps()).toEqual([])
    })

    it('lets a reader list but not add or remove', async () => {
      const created = await readJson<MemberApp>(await create(valid))
      const reader = await h.createRoleUser({ name: 'Viewer', slug: 'viewer', capabilities: ['members.read'] })
      expect((await apps(reader.cookie)).map((app) => app.name)).toEqual(['Instatic Desktop'])
      await expectForbidden(await create(valid, reader.cookie))
      await expectForbidden(await h.cms(`${APPS}/${created.id}`, { method: 'DELETE', cookie: reader.cookie }))
      const editor = await h.createRoleUser({ name: 'Editor', slug: 'editor', capabilities: ['site.read'] })
      await expectForbidden(await h.cms(APPS, { cookie: editor.cookie }))
      expect(await apps()).toHaveLength(1)
    })

    it('asks for the password again before adding or removing an app', async () => {
      const existing = await readJson<MemberApp>(await create(valid))
      const manager = await h.createRoleUser({ name: 'Manager', slug: 'manager', capabilities: ['members.manage'] })
      await expectStepUpRequired(await create({ ...valid, name: 'Second' }, manager.cookie))
      await expectStepUpRequired(await h.cms(`${APPS}/${existing.id}`, { method: 'DELETE', cookie: manager.cookie }))
      expect((await apps()).map((app) => app.name)).toEqual(['Instatic Desktop'])

      // Proving the password again rotates the session; the new one may do both.
      const steppedUp = await h.stepUp(manager.cookie)
      expect((await create({ ...valid, name: 'Second' }, steppedUp)).status).toBe(201)
      expect((await h.cms(`${APPS}/${existing.id}`, { method: 'DELETE', cookie: steppedUp })).status).toBe(200)
      expect((await apps(steppedUp)).map((app) => app.name)).toEqual(['Second'])
    })

    it('adds an app with a trimmed name and each redirect address once, lists it and records it', async () => {
      const res = await create({
        name: '  Instatic Desktop  ',
        redirectUris: ['http://127.0.0.1/callback', 'https://app.example.com/done', 'http://127.0.0.1/callback'],
        scopes: ['profile'],
      })
      expect(res.status).toBe(201)
      const created = await readJson<MemberApp>(res)
      expect(created).toMatchObject({
        name: 'Instatic Desktop',
        redirectUris: ['http://127.0.0.1/callback', 'https://app.example.com/done'],
        scopes: ['profile'],
      })
      expect(created.id).toMatch(/^imem_app_/)
      expect(await apps()).toEqual([created])

      const { events } = await readJson<{ events: Array<{ action: string; metadata: Record<string, unknown> }> }>(
        await h.cms('/admin/api/cms/audit', { cookie: owner }),
      )
      expect(events.find((event) => event.action === 'member.app.create')?.metadata.name).toBe('Instatic Desktop')
    })

    it('refuses a redirect address that is not https or local, and an unknown, repeated or missing scope', async () => {
      for (const uri of ['http://example.com/callback', 'myapp://callback', 'not an address', 'https://user:pw@example.com/']) {
        const res = await create({ ...valid, redirectUris: [uri] })
        expect(res.status).toBe(400)
        expect((await readJson<{ error: string }>(res)).error).toBe(
          'Redirect addresses must use https, or http on this machine (127.0.0.1).',
        )
      }
      expect((await create({ ...valid, redirectUris: [] })).status).toBe(400)
      expect((await create({ ...valid, scopes: ['profile', 'admin'] })).status).toBe(400)
      expect((await create({ ...valid, scopes: ['profile', 'profile'] })).status).toBe(400)
      expect((await create({ ...valid, scopes: [] })).status).toBe(400)
      expect((await create({ ...valid, name: '   ' })).status).toBe(400)
      expect((await create({ ...valid, name: 'x'.repeat(81) })).status).toBe(400)
      expect(await apps()).toEqual([])
    })

    it('removes an app once: it leaves the list, and a second removal answers 404', async () => {
      const created = await readJson<MemberApp>(await create(valid))
      const removed = await h.cms(`${APPS}/${created.id}`, { method: 'DELETE', cookie: owner })
      expect(removed.status).toBe(200)
      expect(await readJson<{ ok: boolean }>(removed)).toEqual({ ok: true })
      expect(await apps()).toEqual([])
      expect((await h.cms(`${APPS}/${created.id}`, { method: 'DELETE', cookie: owner })).status).toBe(404)

      const { events } = await readJson<{ events: Array<{ action: string; metadata: Record<string, unknown> }> }>(
        await h.cms('/admin/api/cms/audit', { cookie: owner }),
      )
      expect(events.find((event) => event.action === 'member.app.delete')?.metadata.name).toBe('Instatic Desktop')
    })
  })
})
