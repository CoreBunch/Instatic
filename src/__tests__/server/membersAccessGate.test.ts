import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { DEFAULT_MEMBER_SETTINGS } from '@core/members'
import { saveMemberSettings } from '../../../server/members/repository'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessRule } from '@core/members'
import type { Page, SiteShell } from '@core/page-tree'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createMember, grantMemberTag } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { decideAccess } from '../../../server/publish/accessGate'
import { publishDataRow } from '../../../server/publish/publishRow'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { resetForTests } from '../../../server/publish/renderCache'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { setTableAccess } from '../../../server/publish/tableAccess'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest, isPublishedSlotUploadPath } from '../../../server/router'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { publishMemberPages } from '../helpers/memberPages'

const ORIGIN = 'http://localhost'
const SECRET_ACCOUNT = 'ACCOUNT-ONLY-MEMBERS-SEE'
const SECRET_VAULT = 'VAULT-ONLY-PRO-SEES'
const SECRET_LESSON = 'LESSON-ONLY-STUDENTS-SEE'

function makeShell(): SiteShell {
  return {
    id: 'site_1',
    name: 'Gate Site',
    files: [],
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

function makePage(id: string, slug: string, text: string, access?: AccessRule): Page {
  return {
    id,
    title: `T-${slug}`,
    slug,
    rootNodeId: 'root',
    nodes: {
      root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [`${id}_text`], classIds: [] },
      [`${id}_text`]: { id: `${id}_text`, moduleId: 'base.text', props: { text, tag: 'h1' }, breakpointOverrides: {}, children: [], classIds: [] },
    },
    ...(access ? { access } : {}),
  } as Page
}

/** Add two lists to a page: the rows of the posts table, and the site's pages. */
function withLists(page: Page): Page {
  const node = (id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []) =>
    ({ id, moduleId, props, breakpointOverrides: {}, children, classIds: [] }) as Page['nodes'][string]
  const p = page.id
  page.nodes.root.children.push(`${p}_posts`, `${p}_pages`)
  page.nodes[`${p}_posts`] = node(`${p}_posts`, 'base.loop', { sourceId: 'data.rows', filters: { tableId: 'posts' } }, [`${p}_post`])
  page.nodes[`${p}_post`] = node(`${p}_post`, 'base.text', { text: 'post', tag: 'p' })
  page.nodes[`${p}_post`].dynamicBindings = { text: { source: 'currentEntry', field: 'title' } }
  page.nodes[`${p}_pages`] = node(`${p}_pages`, 'base.loop', { sourceId: 'site.pages', limit: 50 }, [`${p}_page`])
  page.nodes[`${p}_page`] = node(`${p}_page`, 'base.text', { text: 'page', tag: 'p' })
  page.nodes[`${p}_page`].dynamicBindings = { text: { source: 'currentEntry', field: 'title' } }
  // The same pages again, through the generic rows source aimed at the Pages table.
  page.nodes.root.children.push(`${p}_rows`)
  page.nodes[`${p}_rows`] = node(`${p}_rows`, 'base.loop', { sourceId: 'data.rows', filters: { tableId: 'pages' }, limit: 50 }, [`${p}_row`])
  page.nodes[`${p}_row`] = node(`${p}_row`, 'base.text', { text: 'row', tag: 'h3' })
  page.nodes[`${p}_row`].dynamicBindings = { text: { source: 'currentEntry', field: 'title' } }
  return page
}

describe('members access gate', () => {
  let t: TestDb
  let uploadsDir: string

  beforeEach(async () => {
    resetForTests()
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'access-gate-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
    await saveDraftSite(t.db, MAIN_SCOPE, makeShell())
    // The owner's own sign-in page. Without one a protected page has nowhere to send anyone.
    await saveMemberSettings(t.db, { ...DEFAULT_MEMBER_SETTINGS, pages: await publishMemberPages(t.db, { login: '/sign-in' }) })
    const template = makePage('page_lesson_tpl', 'lesson-template', 'Lesson template')
    template.nodes.page_lesson_tpl_text.dynamicBindings = { text: { source: 'currentEntry', field: 'title' } }
    template.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 100 }
    for (const page of [
      makePage('page_home', 'index', 'Home is public'),
      makePage('page_account', 'account', SECRET_ACCOUNT, { level: 'members', onDeny: 'login' }),
      makePage('page_vault', 'vault', SECRET_VAULT, { level: 'tags', tags: ['pro'], onDeny: 'hide' }),
      withLists(makePage('page_catalog', 'catalog', 'Catalog is public')),
      withLists(makePage('page_library', 'library', 'Library for members', { level: 'members', onDeny: 'login' })),
      template,
    ]) {
      await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
    }
    await createDataRow(t.db, MAIN_SCOPE, {
      id: 'post_1', tableId: 'posts', cells: { title: SECRET_LESSON, slug: 'lesson-one' }, slug: 'lesson-one',
    }, 'admin_1')
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
    await publishDataRow(t.db, 'post_1', 'admin_1', uploadsDir)
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

  /** A confirmed member and the cookie of a live session. */
  async function signedInMember(email: string, tags: string[] = []): Promise<{ id: string; cookie: string }> {
    const member = await createMember(t.db, { email, passwordHash: null, profile: {}, verified: true })
    for (const tag of tags) await grantMemberTag(t.db, { memberId: member!.id, tag, source: 'admin', expiresAt: null })
    const session = await createMemberSession(t.db, member!.id, { ipAddress: null, userAgent: null })
    return { id: member!.id, cookie: `instatic_member=${session.token}` }
  }

  /** Every file in both static slots, as one string, to search for leaked content. */
  async function everythingOnDisk(): Promise<string> {
    let all = ''
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else all += await Bun.file(full).text().catch(() => '')
      }
    }
    await walk(uploadsDir)
    return all
  }

  it('serves the public page from the static slot and keeps protected pages off the disk', async () => {
    const home = await get('/')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Home is public')
    expect(await readArtefact(uploadsDir, '/')).toContain('Home is public')

    expect(await readArtefact(uploadsDir, '/account')).toBeNull()
    expect(await readArtefact(uploadsDir, '/vault')).toBeNull()
    const disk = await everythingOnDisk()
    expect(disk).not.toContain(SECRET_ACCOUNT)
    expect(disk).not.toContain(SECRET_VAULT)
  })

  it('sends a signed-out visitor to the site\'s sign-in page, remembering where they were going', async () => {
    const res = await get('/account?tab=billing')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Faccount%3Ftab%3Dbilling')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.text()).not.toContain(SECRET_ACCOUNT)
  })

  it('has no sign-in page of its own: with none assigned, a members page is just not there', async () => {
    await saveMemberSettings(t.db, DEFAULT_MEMBER_SETTINGS)
    const closed = await get('/account')
    const missing = await get('/no-such-page')
    expect(closed.status).toBe(404)
    expect(await closed.text()).toBe(await missing.text())
    expect((await get('/_instatic/members/sign-in')).status).toBe(404)
    // A member still gets in: signing in is what was missing, not the page.
    const member = await signedInMember('m@example.com')
    expect((await get('/account', member.cookie)).status).toBe(200)
  })

  it('answers a hidden page exactly like a page that does not exist', async () => {
    const hidden = await get('/vault')
    const missing = await get('/no-such-page')
    expect(hidden.status).toBe(missing.status)
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).toBe(await missing.text())
  })

  it('never reveals protected content through any spelling of the path', async () => {
    for (const path of [
      '/account', '/account/', '//account', '/account?x=1', '/account.html', '/ACCOUNT', '/%61ccount',
      '/account/index.html', '/vault', '/vault/', '/vault.html', '/%76ault',
    ]) {
      const body = await (await get(path)).text()
      expect({ path, leaked: body.includes(SECRET_ACCOUNT) || body.includes(SECRET_VAULT) })
        .toEqual({ path, leaked: false })
    }
  })

  it('never serves the published slot through the uploads route', async () => {
    for (const path of [
      '/uploads/published/a/index.html',
      '/uploads/published/b/index.html',
      '/uploads/published/current',
      '/uploads/Published/a/index.html',
      '/uploads/media/../published/a/index.html',
      '/uploads/media%2F..%2Fpublished/a/index.html',
      '/uploads/%70ublished/a/index.html',
      '/uploads//published/a/index.html',
    ]) {
      const res = await get(path)
      expect({ path, status: res.status }).toEqual({ path, status: 404 })
      expect(await res.text()).not.toContain('Home is public')
    }
    expect(isPublishedSlotUploadPath(uploadsDir, '/uploads/media/photo.jpg')).toBe(false)
    expect(isPublishedSlotUploadPath(uploadsDir, '/uploads/published-notes/a.txt')).toBe(false)
  })

  it('lets a signed-in member in, uncached, and never caches it for the next visitor', async () => {
    const member = await signedInMember('m@example.com')
    const res = await get('/account', member.cookie)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.text()).toContain(SECRET_ACCOUNT)

    // The very next anonymous request must not get the member's render.
    const anonymous = await get('/account')
    expect(anonymous.status).toBe(302)
    expect(await anonymous.text()).not.toContain(SECRET_ACCOUNT)
  })

  it('requires the tag, follows grants and expiry at once', async () => {
    const member = await signedInMember('m@example.com')
    expect((await get('/vault', member.cookie)).status).toBe(404)

    await grantMemberTag(t.db, { memberId: member.id, tag: 'pro', source: 'plugin:shop', expiresAt: null })
    const allowed = await get('/vault', member.cookie)
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toContain(SECRET_VAULT)

    const past = new Date(Date.now() - 1000).toISOString()
    await grantMemberTag(t.db, { memberId: member.id, tag: 'pro', source: 'plugin:shop', expiresAt: past })
    expect((await get('/vault', member.cookie)).status).toBe(404)
  })

  it('answers "not found" to a signed-in member without the tag, whatever the page does for signed-out visitors', async () => {
    await saveDataRowDraft(t.db, MAIN_SCOPE, 'page_vault', {
      cells: pageToCells(makePage('page_vault', 'vault', SECRET_VAULT, { level: 'tags', tags: ['pro'], onDeny: 'login' })),
      slug: 'vault',
    }, 'admin_1')
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
    const member = await signedInMember('m@example.com')
    const res = await get('/vault', member.cookie)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SECRET_VAULT)
    // Signed out, the same page sends them to sign in.
    expect((await get('/vault')).status).toBe(302)
  })

  it('shuts a suspended member out on the next request', async () => {
    const member = await signedInMember('m@example.com')
    expect((await get('/account', member.cookie)).status).toBe(200)
    await t.db`update members set status = 'suspended' where id = ${member.id}`
    expect((await get('/account', member.cookie)).status).toBe(302)
  })

  it('removes the baked file when a public page becomes protected', async () => {
    expect(await readArtefact(uploadsDir, '/')).toContain('Home is public')
    expect((await get('/')).status).toBe(200) // warm both cache layers
    await saveDataRowDraft(t.db, MAIN_SCOPE, 'page_home', {
      cells: pageToCells(makePage('page_home', 'index', 'Home is public', { level: 'members', onDeny: 'login' })),
      slug: 'index',
    }, 'admin_1')
    await publishDataRow(t.db, 'page_home', 'admin_1', uploadsDir)

    expect(await readArtefact(uploadsDir, '/')).toBeNull()
    const res = await get('/')
    expect(res.status).toBe(302)
    expect(await res.text()).not.toContain('Home is public')
  })

  it('locks a page whose stored rule cannot be read instead of opening it', async () => {
    const cells = pageToCells(makePage('page_account', 'account', SECRET_ACCOUNT))
    await saveDataRowDraft(t.db, MAIN_SCOPE, 'page_account', {
      cells: { ...cells, access: { level: 'vip-only', nonsense: true } },
      slug: 'account',
    }, 'admin_1')
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
    const member = await signedInMember('m@example.com', ['pro'])
    expect((await get('/account')).status).toBe(404)
    expect((await get('/account', member.cookie)).status).toBe(404)
    expect(await everythingOnDisk()).not.toContain(SECRET_ACCOUNT)
  })

  describe('a protected table', () => {
    it('is public until protected, then closes at once without a publish', async () => {
      const open = await get('/posts/lesson-one')
      expect(open.status).toBe(200)
      expect(await open.text()).toContain(SECRET_LESSON)
      expect(await readArtefact(uploadsDir, '/posts/lesson-one')).toContain(SECRET_LESSON)

      expect(await setTableAccess(t.db, 'posts', { level: 'tags', tags: ['student'], onDeny: 'login' }, uploadsDir)).toBe(true)

      expect(await readArtefact(uploadsDir, '/posts/lesson-one')).toBeNull()
      for (const path of ['/posts/lesson-one', '/posts/lesson-one/', '/posts/lesson-one?x=1', '/Posts/lesson-one']) {
        const res = await get(path)
        expect({ path, leaked: (await res.text()).includes(SECRET_LESSON) }).toEqual({ path, leaked: false })
      }
      expect((await get('/posts/lesson-one')).status).toBe(302)

      const student = await signedInMember('s@example.com', ['student'])
      const res = await get('/posts/lesson-one', student.cookie)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(await res.text()).toContain(SECRET_LESSON)
      expect((await get('/posts/lesson-one')).status).toBe(302)
    })

    it('stays off the disk through later publishes', async () => {
      await setTableAccess(t.db, 'posts', { level: 'members', onDeny: 'hide' }, uploadsDir)
      await publishDraftSite(t.db, 'admin_1', uploadsDir)
      await publishDataRow(t.db, 'post_1', 'admin_1', uploadsDir)
      expect(await everythingOnDisk()).not.toContain(SECRET_LESSON)
      expect((await get('/posts/lesson-one')).status).toBe(404)
    })

    it('gates fragments of its entry template whatever route the caller claims', async () => {
      await setTableAccess(t.db, 'posts', { level: 'tags', tags: ['student'], onDeny: 'hide' }, uploadsDir)
      const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
      const student = await signedInMember('s@example.com', ['student'])
      for (const claimed of ['/', '/posts/lesson-one', '/Posts/lesson-one', '/no-such-page']) {
        const path = `/_instatic/hole/page_lesson_tpl_text?v=${index!.snapshotHash}&u=${encodeURIComponent(claimed)}`
        expect({ claimed, status: (await get(path)).status }).toEqual({ claimed, status: 404 })
        const allowed = await get(path, student.cookie)
        expect(allowed.status).toBe(200)
        expect(allowed.headers.get('cache-control')).toBe('private, no-store')
      }
    })

    it('requires every rule that applies, not just the first', async () => {
      await setTableAccess(t.db, 'posts', { level: 'tags', tags: ['student'], onDeny: 'hide' }, uploadsDir)
      const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
      const hole = (claimed: string) =>
        `/_instatic/hole/page_lesson_tpl_text?v=${index!.snapshotHash}&u=${encodeURIComponent(claimed)}`
      // The template's table wants `student`; the claimed route (/vault) wants `pro`.
      const studentOnly = await signedInMember('s@example.com', ['student'])
      const proOnly = await signedInMember('p@example.com', ['pro'])
      const both = await signedInMember('b@example.com', ['student', 'pro'])
      expect((await get(hole('/vault'), studentOnly.cookie)).status).toBe(404)
      expect((await get(hole('/vault'), proOnly.cookie)).status).toBe(404)
      expect((await get(hole('/vault'), both.cookie)).status).toBe(200)
    })

    it('keeps both rules when two tables differ only by the case of their route base', async () => {
      const memberWith = (tags: string[]) => ({
        id: 'm1', email: 'm@example.com', emailVerified: true, profile: {}, tags, hasPassword: true, createdAt: '',
      })
      const student: AccessRule = { level: 'tags', tags: ['student'], onDeny: 'login' }
      const staff: AccessRule = { level: 'tags', tags: ['staff'], onDeny: 'hide' }
      expect(await decideAccess([student, staff], async () => memberWith(['student']))).toBe('hide')
      expect(await decideAccess([student, staff], async () => memberWith(['staff']))).toBe('forbidden')
      expect(await decideAccess([student, staff], async () => memberWith(['student', 'staff']))).toBe('allow')
      expect(await decideAccess([student, staff], async () => null)).toBe('hide')
      expect(await decideAccess([student], async () => null)).toBe('login')
      expect(await decideAccess([])).toBe('allow')
    })

    it('opens again when the rule is removed', async () => {
      await setTableAccess(t.db, 'posts', { level: 'members', onDeny: 'hide' }, uploadsDir)
      await setTableAccess(t.db, 'posts', { level: 'public' }, uploadsDir)
      const res = await get('/posts/lesson-one')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain(SECRET_LESSON)
    })
  })

  describe('fragments of a protected page', () => {
    const SECRET_FRAGMENT = 'FRAGMENT-ONLY-PRO-SEES'

    async function publishVaultWithHole(): Promise<string> {
      const vault = makePage('page_vault', 'vault', SECRET_VAULT, { level: 'tags', tags: ['pro'], onDeny: 'hide' })
      vault.nodes.root.children.push('vault_hole')
      vault.nodes.vault_hole = {
        id: 'vault_hole', moduleId: 'base.text', props: { text: `${SECRET_FRAGMENT} {route.query.q}`, tag: 'p' },
        breakpointOverrides: {}, children: [], classIds: [],
      } as Page['nodes'][string]
      await saveDataRowDraft(t.db, MAIN_SCOPE, 'page_vault', { cells: pageToCells(vault), slug: 'vault' }, 'admin_1')
      await publishDraftSite(t.db, 'admin_1', uploadsDir)
      const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
      expect(index!.nodeIndex.has('vault_hole')).toBe(true)
      return index!.snapshotHash
    }

    it('are refused to anyone who may not open the page, whatever page they claim to be on', async () => {
      const hash = await publishVaultWithHole()
      const outsider = await signedInMember('o@example.com')
      for (const claimed of ['/vault', '/', '/no-such-page']) {
        for (const cookie of [undefined, outsider.cookie]) {
          const res = await get(`/_instatic/hole/vault_hole?v=${hash}&u=${encodeURIComponent(claimed)}`, cookie)
          expect(res.status).toBe(404)
          expect(await res.text()).not.toContain(SECRET_FRAGMENT)
        }
      }
    })

    it('are rendered for an allowed member only, and never cached for the next visitor', async () => {
      const hash = await publishVaultWithHole()
      const pro = await signedInMember('p@example.com', ['pro'])
      const path = `/_instatic/hole/vault_hole?v=${hash}&u=${encodeURIComponent('/vault?q=hi')}`
      const res = await get(path, pro.cookie)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(await res.text()).toContain(SECRET_FRAGMENT)

      const anonymous = await get(path)
      expect(anonymous.status).toBe(404)
      expect(await anonymous.text()).not.toContain(SECRET_FRAGMENT)
    })
  })

  describe('lists', () => {
    it('leave protected pages out for a signed-out visitor, in the baked page too', async () => {
      const html = await (await get('/catalog')).text()
      expect(html).toContain('T-index')
      for (const closed of ['T-account', 'T-vault', 'T-library']) expect(html).not.toContain(closed)
      // The rows source lists pages too, and follows the same rule.
      expect(html).toContain('<h3>T-index</h3>')
      expect(html).not.toContain('<h3>T-vault</h3>')
      // The row published during setup took the catalog off disk (it lists that
      // table); a full publish bakes it again.
      await publishDraftSite(t.db, 'admin_1', uploadsDir)
      const baked = await readArtefact(uploadsDir, '/catalog')
      expect(baked).toContain('T-index')
      expect(baked).not.toContain('T-vault')
    })

    it('leave a protected table’s rows out at once, and stay that way after a publish', async () => {
      // Bake the catalog with the still-public rows listed on it.
      await publishDraftSite(t.db, 'admin_1', uploadsDir)
      expect(await readArtefact(uploadsDir, '/catalog')).toContain(SECRET_LESSON)

      await setTableAccess(t.db, 'posts', { level: 'tags', tags: ['student'], onDeny: 'hide' }, uploadsDir)
      // The page that listed the rows is no longer served from disk.
      expect(await readArtefact(uploadsDir, '/catalog')).toBeNull()
      expect(await everythingOnDisk()).not.toContain(SECRET_LESSON)
      const live = await get('/catalog')
      expect(live.status).toBe(200)
      expect(await live.text()).not.toContain(SECRET_LESSON)

      await publishDraftSite(t.db, 'admin_1', uploadsDir)
      expect(await readArtefact(uploadsDir, '/catalog')).toContain('Catalog is public')
      expect(await everythingOnDisk()).not.toContain(SECRET_LESSON)
      expect(await (await get('/catalog')).text()).not.toContain(SECRET_LESSON)
    })

    it('show a member, on a members page, exactly what that member may open', async () => {
      await setTableAccess(t.db, 'posts', { level: 'tags', tags: ['student'], onDeny: 'hide' }, uploadsDir)
      const plain = await signedInMember('m@example.com')
      const student = await signedInMember('s@example.com', ['student'])
      const pro = await signedInMember('p@example.com', ['pro'])

      const forPlain = await (await get('/library', plain.cookie)).text()
      expect(forPlain).toContain('Library for members')
      expect(forPlain).toContain('T-account') // any member may open it
      expect(forPlain).not.toContain(SECRET_LESSON)
      expect(forPlain).not.toContain('T-vault')

      expect(await (await get('/library', student.cookie)).text()).toContain(SECRET_LESSON)
      const forPro = await (await get('/library', pro.cookie)).text()
      expect(forPro).toContain('T-vault')
      expect(forPro).toContain('<h3>T-vault</h3>')
      expect(forPlain).not.toContain('<h3>T-vault</h3>')
      expect(forPro).not.toContain(SECRET_LESSON)
    })
  })

  it('keeps the address of a page opened with a link token away from other sites', async () => {
    const res = await get('/?token=abc')
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect((await get('/')).headers.get('referrer-policy')).not.toBe('same-origin')
  })

  it('keeps an app sign-in request private and its approval page out of frames', async () => {
    const approval = await get('/?request=imem_rq_abc')
    expect(approval.headers.get('referrer-policy')).toBe('same-origin')
    expect(approval.headers.get('x-frame-options')).toBe('DENY')
    // The sign-in page it passes through carries the request inside `next`.
    const signIn = await get('/?next=%2Fapprove-app%3Frequest%3Dimem_rq_abc')
    expect(signIn.headers.get('referrer-policy')).toBe('same-origin')
    expect((await get('/')).headers.get('x-frame-options')).toBeNull()
  })
})
