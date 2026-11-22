/**
 * The members demo site (`bun run demo:members`) is built from editor
 * primitives by `scripts/lib/membersDemoSite.ts`. This keeps it honest: the
 * pages publish, the public ones are open, the protected ones are closed to
 * the right people, and what a member sees is theirs.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePage, type SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { buildMembersDemoPages, MEMBERS_DEMO_CSS, membersDemoSettings } from '../../../scripts/lib/membersDemoSite'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createMemberApp, createMemberAppRequest } from '../../../server/members/apps/store'
import { createMember, grantMemberTag, saveMemberSettings } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const ORIGIN = 'http://localhost'

function shell(): SiteShell {
  return {
    id: 'site_demo',
    name: 'Northlight Club',
    files: [{ id: 'css_demo', path: 'styles/members-demo.css', type: 'style', content: MEMBERS_DEMO_CSS }],
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: normalizeSiteRuntimeConfig(undefined),
    createdAt: 1000,
    updatedAt: 2000,
  }
}

describe('members demo site', () => {
  let t: TestDb
  let uploadsDir: string

  beforeEach(async () => {
    resetForTests()
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'members-demo-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
    await saveDraftSite(t.db, MAIN_SCOPE, shell())
    for (const page of buildMembersDemoPages()) {
      await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
    }
    await saveMemberSettings(t.db, membersDemoSettings())
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
  })

  afterEach(async () => {
    await t.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  function get(path: string, cookie?: string): Promise<Response> {
    const req = new Request(`${ORIGIN}${path}`, { redirect: 'manual' })
    if (cookie) req.headers.set('cookie', cookie)
    return handleServerRequest(req, { db: t.db, uploadsDir })
  }

  async function signedIn(email: string, name: string, tags: string[] = []): Promise<string> {
    const member = await createMember(t.db, { email, passwordHash: 'x', profile: { name }, verified: true })
    for (const tag of tags) await grantMemberTag(t.db, { memberId: member!.id, tag, source: 'admin', expiresAt: null })
    const session = await createMemberSession(t.db, member!.id, { ipAddress: null, userAgent: null })
    return `instatic_member=${session.token}`
  }

  it('is made of pages the editor accepts as they are', () => {
    for (const page of buildMembersDemoPages()) {
      // Round-trips through the same parser the editor and the server use.
      const parsed = parsePage(JSON.parse(JSON.stringify(page)))
      expect(Object.keys(parsed.nodes).sort()).toEqual(Object.keys(page.nodes).sort())
      for (const node of Object.values(page.nodes)) {
        for (const childId of node.children) expect(page.nodes[childId]?.parentId).toBe(node.id)
      }
    }
  })

  it('opens the public pages to anyone and sends a visitor to the sign-in page for the rest', async () => {
    for (const path of ['/', '/join', '/sign-in', '/forgot-password', '/reset-password', '/welcome', '/invitation']) {
      const res = await get(path)
      expect(`${path} ${res.status}`).toBe(`${path} 200`)
      const html = await res.text()
      expect(html).toContain('Northlight Club')
      expect(html).not.toContain('instatic: unknown module')
    }
    for (const path of ['/account', '/members', '/pro']) {
      const res = await get(path)
      expect(res.status).toBe(302)
      // The owner assigned a sign-in page, so that is where a visitor lands.
      expect(res.headers.get('location')).toBe(`/sign-in?next=${encodeURIComponent(path)}`)
    }
  })

  it('shows each member their own account, and the pro page only to a member with the tag', async () => {
    const mia = await signedIn('mia@example.com', 'Mia')
    const paul = await signedIn('paul@example.com', 'Paul', ['pro'])

    const account = await (await get('/account', mia)).text()
    expect(account).toContain('Signed in as mia@example.com')
    // The profile form opens with her name in it.
    expect(account).toMatch(/name="name"[^>]*value="Mia"|value="Mia"[^>]*name="name"/)
    expect(account).not.toContain('paul@example.com')

    // Without the tag the page is not there for her.
    expect((await get('/pro', mia)).status).toBe(404)
    const pro = await get('/pro', paul)
    expect(pro.status).toBe(200)
    expect(await pro.text()).toContain('You hold the tag')
    expect((await get('/members', mia)).status).toBe(200)
  })

  it('lists a member the apps signed in to their account, each with its own disconnect form', async () => {
    const mia = await signedIn('mia@example.com', 'Mia')
    const paul = await signedIn('paul@example.com', 'Paul')
    const app = await createMemberApp(t.db, { name: 'Northlight Desktop', redirectUris: [], scopes: ['profile'], createdByUserId: null })
    const { rows } = await t.db<{ id: string }>`select id from members where email = 'mia@example.com'`
    const now = Date.now()
    await t.db`
      insert into member_app_grants (id, member_id, app_id, scope, created_at, expires_at)
      values ('grant_mia', ${rows[0].id}, ${app.id}, 'profile', ${new Date(now).toISOString()}, ${new Date(now + 86_400_000).toISOString()})
    `

    // The list is fetched after the page, for the member who is looking.
    const page = await (await get('/account', mia)).text()
    const at = page.indexOf('Connected apps')
    const hole = /data-instatic-hole="([^"]+)" data-instatic-version="([^"]+)"/.exec(page.slice(at))!
    const fragment = (cookie?: string) =>
      get(`/_instatic/hole/${hole[1]}?v=${hole[2]}&u=${encodeURIComponent('/account')}`, cookie)

    const mine = await fragment(mia)
    expect(mine.headers.get('cache-control')).toContain('no-store')
    const html = await mine.text()
    expect(html).toContain('Northlight Desktop')
    expect(html).toContain('Last used not yet')
    expect(html).toContain('action="/_instatic/members/apps/disconnect"')
    expect(html).toMatch(/type="hidden"[^>]*name="connection"[^>]*value="grant_mia"/)

    expect(await (await fragment(paul)).text()).not.toContain('Northlight Desktop')
    expect((await fragment()).status).toBe(404)
  })

  it('gives the approval form its request, so it posts with scripts off', async () => {
    const mia = await signedIn('mia@example.com', 'Mia')
    const app = await createMemberApp(t.db, {
      name: 'Instatic Desktop', redirectUris: ['http://127.0.0.1:47821/callback'], scopes: ['profile'], createdByUserId: null,
    })
    const request = await createMemberAppRequest(t.db, {
      appId: app.id,
      browserMarker: 'a'.repeat(32),
      redirectUri: 'http://127.0.0.1:47821/callback',
      codeChallenge: 'c'.repeat(43),
      scope: 'profile',
      resource: `${ORIGIN}/_instatic/members`,
      state: null,
    })
    const field = (id: string) => `<input type="hidden" name="request" data-instatic-member-link-param="request" value="${id}">`

    const page = await (await get(`/approve-app?request=${request}`, mia)).text()
    expect(page).toContain('Sign in to Instatic Desktop?')
    expect(page).toContain(field(request))

    // An address that names no waiting request leaves the field empty.
    const stale = await (await get('/approve-app?request=imem_rq_unknown', mia)).text()
    expect(stale).toContain('<input type="hidden" name="request" data-instatic-member-link-param="request">')
    expect(stale).not.toContain(field('imem_rq_unknown'))
  })

  it('keeps every member-only line out of what is written to disk', async () => {
    const home = await (await get('/')).text()
    // The home page greets by name and lists tags, but only inside per-visitor fragments.
    expect(home).not.toContain('You are signed in as')
    expect(home).toContain('<instatic-hole')
  })
})
