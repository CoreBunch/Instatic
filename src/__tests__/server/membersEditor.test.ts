/**
 * What the editor's member primitives do on the published site: `member.*`
 * bindings, show-when rules and member forms, plus the access controls the
 * editor saves through (page access in the write guard and relay cells, the
 * table access endpoint).
 *
 * The property that matters most: something rendered for one visitor is
 * never served to another, from the static slot or a shared cache.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registry } from '@core/module-engine'
import { hookBus } from '@core/plugins/hookBus'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { memberFormActionPath, readShowWhen, showWhenAllows, type AccessRule } from '@core/members'
import { duplicatePage, type Page, type SiteDocument, type SiteShell } from '@core/page-tree'
import {
  publishPage,
  showWhenPathsAllow,
  showWhenPathsAreGated,
  showWhenPathsTo,
  subtreeDependsOnMember,
} from '@core/publisher'
import { findDynamicNodeIds } from '../../core/publisher/dynamicDetection'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '../../core/data/pageFromRow'
import { FORM_RUNTIME_JS } from '../../modules/base/forms/formRuntimeJs'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { mergeDerivedCells } from '../../../server/collab/relayPersistence'
import { createMember, grantMemberTag } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow, getDataRow } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
import { validatePageWriteDiff } from '../../../server/writePolicy/pageDiff'
import { ForbiddenSiteChangeError } from '../../../server/writePolicy/siteDiff'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const ORIGIN = 'http://localhost'

type Node = Page['nodes'][string]

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []): Node {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] } as Node
}

function makeShell(): SiteShell {
  return {
    id: 'site_1',
    name: 'Members Site',
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

function makePage(id: string, slug: string, nodes: Node[], access?: AccessRule): Page {
  return {
    id,
    title: `T-${slug}`,
    slug,
    rootNodeId: 'root',
    nodes: Object.fromEntries([
      ['root', node('root', 'base.body', {}, nodes.filter((n) => !n.id.includes('__')).map((n) => n.id))],
      ...nodes.map((n) => [n.id, n] as const),
    ]),
    ...(access ? { access } : {}),
  } as Page
}

/** A greeting bound to the member, a members-only line and a visitors-only line. */
function memberNodes(prefix: string): Node[] {
  return [
    node(`${prefix}_plain`, 'base.text', { text: 'Open to all', tag: 'p' }),
    node(`${prefix}_hello`, 'base.text', { text: 'Hello {member.profile.name|stranger}', tag: 'p' }),
    node(`${prefix}_in`, 'base.text', { text: 'MEMBERS-LINE', tag: 'p', showWhen: { visitor: 'signedIn' } }),
    node(`${prefix}_out`, 'base.text', { text: 'VISITORS-LINE', tag: 'p', showWhen: { visitor: 'signedOut' } }),
    node(`${prefix}_pro`, 'base.text', { text: 'PRO-LINE', tag: 'p', showWhen: { visitor: 'tags', tags: ['pro'] } }),
  ]
}

/**
 * A public page whose pro-only box holds a line and a list, beside a list
 * that is itself for signed-in members only. Each has an id a visitor could
 * ask the fragment and list endpoints for directly.
 */
function gatedPage(): Page {
  const loop = {
    sourceId: 'site.pages', filters: {}, orderBy: 'definition', direction: 'asc', limit: 10, offset: 0,
    pagination: 'infinite', pageSize: 10, tag: 'div', customTag: '',
  }
  return {
    id: 'page_gated',
    title: 'Gated',
    slug: 'gated',
    rootNodeId: 'root',
    nodes: Object.fromEntries(
      [
        node('root', 'base.body', {}, ['gate', 'members_loop']),
        node('gate', 'base.container', { showWhen: { visitor: 'tags', tags: ['pro'] } }, ['gate_line', 'gate_loop']),
        node('gate_line', 'base.text', { text: 'PRO-BOX-LINE', tag: 'p' }),
        node('gate_loop', 'base.loop', loop, ['gate_loop_item']),
        node('gate_loop_item', 'base.text', { text: 'PRO-BOX-ITEM {currentEntry.title}', tag: 'p' }),
        node('members_loop', 'base.loop', { ...loop, showWhen: { visitor: 'signedIn' } }, ['members_loop_item']),
        node('members_loop_item', 'base.text', { text: 'MEMBERS-LIST-ITEM {currentEntry.title}', tag: 'p' }),
      ].map((entry) => [entry.id, entry]),
    ),
  } as Page
}

function siteWith(pages: Page[]): SiteDocument {
  return { ...makeShell(), pages } as unknown as SiteDocument
}

describe('member bindings and show-when rules', () => {
  describe('in the publisher', () => {
    const page = makePage('p', 'p', memberNodes('p'))
    const site = siteWith([page])

    it('defers member-dependent nodes to per-visitor fragments, unless the visitor is known', () => {
      expect([...findDynamicNodeIds(page, site, registry)].sort()).toEqual(['p_hello', 'p_in', 'p_out', 'p_pro'])
      expect(findDynamicNodeIds(page, site, registry, { visitorKnown: true }).size).toBe(0)
      expect(subtreeDependsOnMember(page, site, registry, 'p_hello')).toBe(true)
      expect(subtreeDependsOnMember(page, site, registry, 'p_plain')).toBe(false)
    })

    describe('rules above a node, along the render path', () => {
      const pro = { visitor: 'tags', tags: ['pro'] } as const
      const component = (id: string, nodes: Node[]) =>
        ({ id, name: id, tree: { rootNodeId: 'vc_root', nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) } }) as unknown as SiteDocument['visualComponents'][number]
      const siteOf = (pageNodes: Node[], componentNodes: Node[]) => {
        const refPage = makePage('r', 'r', pageNodes)
        return { refPage, site: { ...siteWith([refPage]), visualComponents: [component('vc', componentNodes)] } as SiteDocument }
      }

      it('puts a list inside a component under the reference that placed it', () => {
        const { refPage, site } = siteOf(
          [node('ref', 'base.visual-component-ref', { componentId: 'vc', showWhen: pro })],
          [node('vc_root', 'base.container', {}, ['vc_loop']), node('vc_loop', 'base.loop', {})],
        )
        const paths = showWhenPathsTo(refPage, site, 'vc_loop', { includeSelf: true })
        expect(paths).toEqual([[pro]])
        expect(showWhenPathsAreGated(paths)).toBe(true)
        expect(showWhenPathsAllow(paths, null)).toBe(false)
        expect(showWhenPathsAllow(paths, [])).toBe(false)
        expect(showWhenPathsAllow(paths, ['pro'])).toBe(true)
      })

      it('puts a list inside a component under the component\'s own limited elements', () => {
        const { refPage, site } = siteOf(
          [node('ref', 'base.visual-component-ref', { componentId: 'vc' })],
          [
            node('vc_root', 'base.container', { showWhen: { visitor: 'signedIn' } }, ['vc_loop']),
            node('vc_loop', 'base.loop', {}),
          ],
        )
        const paths = showWhenPathsTo(refPage, site, 'vc_loop', { includeSelf: true })
        expect(showWhenPathsAllow(paths, null)).toBe(false)
        expect(showWhenPathsAllow(paths, [])).toBe(true)
      })

      it('puts slot content under the outlet it fills, and gives unplaced content to nobody', () => {
        const { refPage, site } = siteOf(
          [
            node('ref', 'base.visual-component-ref', { componentId: 'vc' }, ['ref__fill', 'ref__lost']),
            node('ref__fill', 'base.slot-instance', { slotName: 'body' }, ['ref__fill_text']),
            node('ref__fill_text', 'base.text', { text: 'x', tag: 'p' }),
            node('ref__lost', 'base.slot-instance', { slotName: 'gone' }, ['ref__lost_text']),
            node('ref__lost_text', 'base.text', { text: 'y', tag: 'p' }),
          ],
          [
            node('vc_root', 'base.container', {}, ['vc_box']),
            node('vc_box', 'base.container', { showWhen: pro }, ['vc_outlet']),
            node('vc_outlet', 'base.slot-outlet', { slotName: 'body' }),
          ],
        )
        const filled = showWhenPathsTo(refPage, site, 'ref__fill_text', { includeSelf: false })
        expect(showWhenPathsAllow(filled, [])).toBe(false)
        expect(showWhenPathsAllow(filled, ['pro'])).toBe(true)
        const lost = showWhenPathsTo(refPage, site, 'ref__lost_text', { includeSelf: false })
        expect(showWhenPathsAllow(lost, ['pro'])).toBe(false)
      })

      it('treats a node on no render path as limited, and open to nobody', () => {
        const { refPage, site } = siteOf([node('plain', 'base.text', { text: 'x', tag: 'p' })], [node('vc_root', 'base.loop', {})])
        const paths = showWhenPathsTo(refPage, site, 'vc_root', { includeSelf: true })
        expect(paths).toEqual([])
        expect(showWhenPathsAreGated(paths)).toBe(true)
        expect(showWhenPathsAllow(paths, ['pro'])).toBe(false)
        expect(showWhenPathsAreGated(showWhenPathsTo(refPage, site, 'plain', { includeSelf: true }))).toBe(false)
      })

      it('gives a node whose rule is bound to a component parameter to nobody', () => {
        const bound = { ...node('vc_root', 'base.loop', {}), propBindings: { showWhen: { paramId: 'p1' } } } as Node
        const { refPage, site } = siteOf([node('ref', 'base.visual-component-ref', { componentId: 'vc' })], [bound])
        const paths = showWhenPathsTo(refPage, site, 'vc_root', { includeSelf: true })
        expect(showWhenPathsAreGated(paths)).toBe(true)
        expect(showWhenPathsAllow(paths, ['pro'])).toBe(false)
      })

      it('lets a visitor in through any one placement of a component used twice', () => {
        const { refPage, site } = siteOf(
          [
            node('open_ref', 'base.visual-component-ref', { componentId: 'vc' }),
            node('pro_ref', 'base.visual-component-ref', { componentId: 'vc', showWhen: pro }),
          ],
          [node('vc_root', 'base.loop', {})],
        )
        const paths = showWhenPathsTo(refPage, site, 'vc_root', { includeSelf: true })
        expect(paths).toHaveLength(2)
        expect(showWhenPathsAllow(paths, null)).toBe(true)
      })
    })

    it('finds a member token inside an authored HTML attribute', () => {
      const attrPage = makePage('a', 'a', [
        node('a_box', 'base.text', { text: 'x', tag: 'p', htmlAttributes: { 'data-user': '{member.id}' } }),
      ])
      expect(subtreeDependsOnMember(attrPage, siteWith([attrPage]), registry, 'a_box')).toBe(true)
    })

    it('bakes nothing about any member into a page rendered for nobody', () => {
      const { html } = publishPage(page, site, registry)
      expect(html).toContain('Open to all')
      for (const hidden of ['Hello', 'MEMBERS-LINE', 'VISITORS-LINE', 'PRO-LINE']) expect(html).not.toContain(hidden)
      expect(html.match(/<instatic-hole /g)).toHaveLength(4)
    })

    it('renders in place for a known visitor and escapes what the member typed', () => {
      const member = { id: 'm1', email: 'a@example.com', profile: { name: '<img src=x onerror=alert(1)>' }, tags: ['pro'], tagList: 'pro' }
      const { html } = publishPage(page, site, registry, { templateContext: { entryStack: [], member } })
      expect(html).not.toContain('<instatic-hole')
      expect(html).toContain('Hello &lt;img src=x onerror=alert(1)&gt;')
      expect(html).toContain('MEMBERS-LINE')
      expect(html).toContain('PRO-LINE')
      expect(html).not.toContain('VISITORS-LINE')

      const signedOut = publishPage(page, site, registry, { templateContext: { entryStack: [], member: null } }).html
      expect(signedOut).toContain('Hello stranger')
      expect(signedOut).toContain('VISITORS-LINE')
      expect(signedOut).not.toContain('MEMBERS-LINE')
      expect(signedOut).not.toContain('PRO-LINE')
    })

    it('shows nobody an element whose rule cannot be read', () => {
      expect(readShowWhen({ showWhen: { visitor: 'admins' } })).toBe('nobody')
      expect(readShowWhen({ showWhen: { visitor: 'tags', tags: [] } })).toBe('nobody')
      expect(showWhenAllows('nobody', ['pro'])).toBe(false)
      expect(showWhenAllows(null, null)).toBe(true)
    })
  })

  describe('on the published site', () => {
    let t: TestDb
    let uploadsDir: string

    beforeEach(async () => {
      resetForTests()
      t = await createTestDb()
      uploadsDir = await mkdtemp(join(tmpdir(), 'members-editor-'))
      await t.db`
        insert into users (id, email, email_normalized, display_name, password_hash, role_id)
        values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
      `
      await saveDraftSite(t.db, MAIN_SCOPE, makeShell())
      for (const page of [
        makePage('page_home', 'index', memberNodes('home')),
        makePage('page_account', 'account', memberNodes('acct'), { level: 'members', onDeny: 'login' }),
        gatedPage(),
      ]) {
        await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
      }
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
      const member = await createMember(t.db, { email, passwordHash: null, profile: { name }, verified: true })
      for (const tag of tags) await grantMemberTag(t.db, { memberId: member!.id, tag, source: 'admin', expiresAt: null })
      const session = await createMemberSession(t.db, member!.id, { ipAddress: null, userAgent: null })
      return `instatic_member=${session.token}`
    }

    async function hole(nodeId: string, cookie?: string): Promise<Response> {
      const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
      return get(`/_instatic/hole/${nodeId}?v=${index!.snapshotHash}&u=${encodeURIComponent('/')}`, cookie)
    }

    it('hands a page rendered for a member only to plugins that may read members', async () => {
      const ada = await signedIn('ada@example.com', 'Ada')
      hookBus.filter('test.reader', 'publish.html', (html) => `${String(html)}<!--seen:${String(html).includes('Hello Ada')}-->`)
      try {
        // The member's own page does not reach a plugin without the permission.
        const withheld = await (await get('/account', ada)).text()
        expect(withheld).toContain('Hello Ada')
        expect(withheld).not.toContain('<!--seen:')

        hostPlugins.set('test.reader', { manifest: { id: 'test.reader', grantedPermissions: ['members.read'] } } as never)
        expect(await (await get('/account', ada)).text()).toContain('<!--seen:true-->')
      } finally {
        hookBus.unregisterPlugin('test.reader')
        hostPlugins.delete('test.reader')
      }
    })

    it('keeps member data out of the baked public page and serves it per visitor', async () => {
      const ada = await signedIn('ada@example.com', 'Ada', ['pro'])
      const bob = await signedIn('bob@example.com', 'Bob')

      // The page itself is the same for everyone, signed in or not.
      const page = await (await get('/', ada)).text()
      expect(page).toContain('Open to all')
      expect(page).not.toContain('Ada')
      expect(page).not.toContain('MEMBERS-LINE')

      // Ada first, so a shared cache would have her fragment to hand out.
      const forAda = await hole('home_hello', ada)
      expect(await forAda.text()).toContain('Hello Ada')
      expect(forAda.headers.get('cache-control')).toBe('private, no-store')
      expect(await (await hole('home_hello', bob)).text()).toContain('Hello Bob')
      const anonymous = await (await hole('home_hello')).text()
      expect(anonymous).toContain('Hello stranger')
      expect(anonymous).not.toContain('Ada')

      expect(await (await hole('home_in', ada)).text()).toContain('MEMBERS-LINE')
      expect(await (await hole('home_in')).text()).not.toContain('MEMBERS-LINE')
      expect(await (await hole('home_out')).text()).toContain('VISITORS-LINE')
      expect(await (await hole('home_out', ada)).text()).not.toContain('VISITORS-LINE')
      expect(await (await hole('home_pro', ada)).text()).toContain('PRO-LINE')
      expect(await (await hole('home_pro', bob)).text()).not.toContain('PRO-LINE')
    })

    it('never writes a member-dependent line to the static slot', async () => {
      let all = ''
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else all += await Bun.file(full).text().catch(() => '')
        }
      }
      await walk(uploadsDir)
      expect(all).toContain('Open to all')
      for (const hidden of ['MEMBERS-LINE', 'VISITORS-LINE', 'PRO-LINE', 'Hello ']) expect(all).not.toContain(hidden)
    })

    it('does not hand out a child of a limited element to someone who asks for it directly', async () => {
      const pro = await signedIn('pro@example.com', 'Pro', ['pro'])
      const plain = await signedIn('plain@example.com', 'Plain')
      const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
      const fragment = (nodeId: string, cookie?: string) =>
        get(`/_instatic/hole/${nodeId}?v=${index!.snapshotHash}&u=${encodeURIComponent('/gated')}`, cookie)
      const list = (loopId: string, cookie?: string) => get(`/_instatic/loop/${loopId}?page=1`, cookie)

      // The line inside the pro-only box, fetched on its own.
      for (const cookie of [undefined, plain]) {
        const res = await fragment('gate_line', cookie)
        expect(await res.text()).not.toContain('PRO-BOX-LINE')
        expect(res.headers.get('cache-control')).toBe('private, no-store')
      }
      expect(await (await fragment('gate_line', pro)).text()).toContain('PRO-BOX-LINE')
      // Asked for again by a visitor after the member saw it: nothing was kept in a shared cache.
      expect(await (await fragment('gate_line')).text()).not.toContain('PRO-BOX-LINE')

      // More items of a list inside the box, and of a list with its own rule.
      expect(await (await list('gate_loop')).text()).not.toContain('PRO-BOX-ITEM')
      expect(await (await list('gate_loop', plain)).text()).not.toContain('PRO-BOX-ITEM')
      expect(await (await list('gate_loop', pro)).text()).toContain('PRO-BOX-ITEM')
      const signedOutList = await list('members_loop')
      expect(await signedOutList.text()).not.toContain('MEMBERS-LIST-ITEM')
      expect(signedOutList.headers.get('cache-control')).toBe('private, no-store')
      expect(await (await list('members_loop', plain)).text()).toContain('MEMBERS-LIST-ITEM')
    })

    it('renders a protected page in one piece for its member', async () => {
      const ada = await signedIn('ada@example.com', 'Ada')
      const res = await get('/account', ada)
      const html = await res.text()
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(html).toContain('Hello Ada')
      expect(html).toContain('MEMBERS-LINE')
      expect(html).not.toContain('VISITORS-LINE')
      expect(html).not.toContain('PRO-LINE')
      expect(html).not.toContain('<instatic-hole')
    })
  })
})

describe('a page inside a site-wide layout', () => {
  let t: TestDb
  let uploadsDir: string

  /** A layout whose content area is for signed-in members only, with a greeting in its header. */
  function layout(): Page {
    return {
      ...makePage('page_layout', 'layout', [
        node('lay_hello', 'base.text', { text: 'Header for {member.profile.name|nobody}', tag: 'p' }),
        node('lay_box', 'base.container', { showWhen: { visitor: 'signedIn' } }, ['lay__outlet']),
        node('lay__outlet', 'base.outlet', {}),
      ]),
      template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 },
    } as Page
  }

  beforeEach(async () => {
    resetForTests()
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'members-layout-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
    await saveDraftSite(t.db, MAIN_SCOPE, makeShell())
    for (const page of [layout(), makePage('page_home', 'index', memberNodes('home'))]) {
      await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
    }
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

  it('does not hand a signed-out visitor page content the layout limits to members', async () => {
    const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
    const hole = (id: string, cookie?: string) =>
      get(`/_instatic/hole/${id}?v=${index!.snapshotHash}&u=${encodeURIComponent('/')}`, cookie)

    // The page as baked: the limited box is a per-visitor fragment, and none of the page is in it.
    const html = await (await get('/')).text()
    expect(html).toContain('data-instatic-hole="lay_box"')
    expect(html).not.toContain('Open to all')

    // Asking for a page element by its id is still under the layout's rule.
    const anonymous = await hole('home_plain')
    expect(await anonymous.text()).toBe('')
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store')
    expect(await (await hole('home_hello')).text()).toBe('')

    const member = await createMember(t.db, { email: 'ada@example.com', passwordHash: null, profile: { name: 'Ada' }, verified: true })
    const session = await createMemberSession(t.db, member!.id, { ipAddress: null, userAgent: null })
    const cookie = `instatic_member=${session.token}`
    expect(await (await hole('home_plain', cookie)).text()).toContain('Open to all')
    expect(await (await hole('home_hello', cookie)).text()).toContain('Hello Ada')

    // The layout's own header is under nothing.
    expect(await (await hole('lay_hello')).text()).toContain('Header for nobody')
  })
})

describe('member forms', () => {
  const render = (props: Record<string, unknown>) => {
    const form = makePage('f', 'f', [node('f_form', 'base.form', { mode: 'member', formId: 'join', ...props })])
    return publishPage(form, siteWith([form]), registry)
  }

  it('posts to the member endpoint and still works without scripts', () => {
    const { html, jsModuleIds } = render({ memberAction: 'signup', successBehavior: 'redirect', redirectUrl: '/welcome' })
    expect(html).toContain('action="/_instatic/members/signup" method="post"')
    expect(html).toContain('data-instatic-form-mode="member"')
    expect(html).toContain('<input type="hidden" name="_success" value="/welcome">')
    expect(html).not.toContain('data-instatic-honeypot')
    expect(jsModuleIds).toContain('base.form')
  })

  it('carries the emailed token only on forms that are opened from a link', () => {
    expect(render({ memberAction: 'password/reset' }).html).toContain('name="token" data-instatic-member-token')
    expect(render({ memberAction: 'login' }).html).not.toContain('data-instatic-member-token')
  })

  it('never posts to a path the catalogue does not know', () => {
    expect(memberFormActionPath('../../admin/api/cms/site')).toBe('/_instatic/members/login')
    expect(render({ memberAction: '"><script>' }).html).toContain('action="/_instatic/members/login"')
  })

  it('ships a runtime that parses', () => {
    expect(() => new Function(FORM_RUNTIME_JS)).not.toThrow()
  })

  it('follows ?next= after sign-in only to a path on the same site', async () => {
    // Run the runtime against a minimal page: one member form, a sign-in that succeeds.
    const visit = async (next: string): Promise<string> => {
      const assigned: string[] = []
      const listeners: Record<string, (event: unknown) => void> = {}
      const form = {
        tagName: 'FORM',
        isConnected: true,
        matches: () => true,
        getAttribute: (name: string) =>
          ({ 'data-instatic-form-mode': 'member', 'data-instatic-form-id': 'f', action: '/_instatic/members/login' })[name] ?? null,
        setAttribute: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        contains: () => false,
        reset: () => {},
      }
      const windowStub = {
        location: {
          search: `?next=${encodeURIComponent(next)}`,
          origin: 'https://site.example',
          pathname: '/sign-in',
          assign: (url: string) => assigned.push(url),
        },
      }
      const documentStub = {
        querySelectorAll: () => [],
        addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn },
        documentElement: {},
      }
      const fetchStub = async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, code: 'signed_in' }) })
      class FormDataStub { entries() { return [] } }
      new Function('window', 'document', 'fetch', 'FormData', 'MutationObserver', FORM_RUNTIME_JS)(
        windowStub, documentStub, fetchStub, FormDataStub, undefined,
      )
      listeners.submit({ target: form, preventDefault: () => {} })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return assigned[0] ?? ''
    }

    expect(await visit('/account?tab=billing')).toBe('https://site.example/account?tab=billing')
    // Dot segments that collapse to a double slash stay on this site, spelled out in full.
    expect(await visit('/.//evil.example')).toBe('https://site.example//evil.example')
    expect(await visit('/..//evil.example')).toBe('https://site.example//evil.example')
    // Each of these would leave the site; the form falls back to reloading its own page.
    for (const hostile of ['//evil.example/', '/\\evil.example/', '/\t/evil.example/', '/\n/evil.example', 'https://evil.example/']) {
      expect(await visit(hostile)).toBe('/sign-in')
    }
  })
})

describe('saving access from the editor', () => {
  const page = (access?: AccessRule): Page => makePage('page_a', 'a', [node('a_text', 'base.text', { text: 'x', tag: 'p' })], access)
  const rule: AccessRule = { level: 'members', onDeny: 'login' }

  it('lets only a structure editor change who may open a page', () => {
    const change = (capabilities: Parameters<typeof validatePageWriteDiff>[0]['capabilities'], from: Page, to: Page) =>
      validatePageWriteDiff({ previousPages: [from], changedPages: [to], deletedPageIds: new Set(), capabilities })
    // Opening a protected page to everyone, and locking an open one.
    expect(() => change(['site.content.edit', 'site.style.edit'], page(rule), page())).toThrow(ForbiddenSiteChangeError)
    expect(() => change(['site.content.edit'], page(), page(rule))).toThrow(ForbiddenSiteChangeError)
    expect(() => change(['site.structure.edit'], page(rule), page())).not.toThrow()
  })

  it('drops the stored rule when a page goes back to public', () => {
    const owned = ['title', 'slug', 'body', 'templateEnabled', 'templateTarget', 'templatePriority', 'access']
    const stored = { ...pageToCells(page(rule)), seoTitle: 'kept' }
    const merged = mergeDerivedCells(stored, pageToCells(page()), owned)
    expect(merged.access).toBeUndefined()
    expect(merged.seoTitle).toBe('kept')
  })

  it('copies the rule when a page is duplicated', () => {
    const site = siteWith([page(rule)])
    const copy = duplicatePage(site, 'page_a', 'Copy')
    expect(copy.access).toEqual(rule)
    expect(duplicatePage(siteWith([page()]), 'page_a', 'Copy').access).toBeUndefined()
  })

  describe('a page saved as a row', () => {
    let h: CapabilityTestHarness
    let ownerId: string

    beforeEach(async () => {
      resetForTests()
      h = await createCapabilityTestHarness()
      await h.setupOwner()
      const { rows } = await h.db<{ id: string }>`select id from users limit 1`
      ownerId = rows[0].id
      await createDataRow(h.db, MAIN_SCOPE, { id: 'page_a', tableId: 'pages', cells: pageToCells(page(rule)), slug: 'a' }, ownerId)
    })
    afterEach(async () => {
      await h.cleanup()
    })

    const storedAccess = async () => (await getDataRow(h.db, MAIN_SCOPE, 'page_a'))?.cells.access
    const cellsWithout = async (key: string) => {
      const { [key]: _dropped, ...cells } = (await getDataRow(h.db, MAIN_SCOPE, 'page_a'))!.cells
      return cells
    }

    it('keeps its rule when a content editor saves the row without it, or with another one', async () => {
      const writer = await h.createRoleUser({
        name: 'Writer', slug: 'writer', capabilities: ['content.edit.any', 'content.publish.any', 'data.system.tables.read'],
      })
      const dropped = await h.cms('/admin/api/cms/data/rows/page_a', {
        method: 'PATCH', cookie: writer.cookie, json: { cells: await cellsWithout('access') },
      })
      expect(dropped.status).toBe(200)
      expect(await storedAccess()).toEqual(rule)

      await h.cms('/admin/api/cms/data/rows/page_a', {
        method: 'PATCH', cookie: writer.cookie, json: { cells: { ...(await cellsWithout('access')), access: { level: 'public' } } },
      })
      expect(await storedAccess()).toEqual(rule)
    })

    it('lets a structure editor change it through the same endpoint', async () => {
      const builder = await h.createRoleUser({
        name: 'Builder', slug: 'builder',
        capabilities: ['content.edit.any', 'data.system.tables.read', 'site.structure.edit'],
      })
      await h.cms('/admin/api/cms/data/rows/page_a', {
        method: 'PATCH', cookie: builder.cookie, json: { cells: await cellsWithout('access') },
      })
      expect(await storedAccess()).toBeUndefined()
    })
  })

  describe('table access endpoint', () => {
    let h: CapabilityTestHarness
    let owner: string

    beforeEach(async () => {
      resetForTests()
      h = await createCapabilityTestHarness()
      owner = await h.setupOwner()
    })
    afterEach(async () => {
      await h.cleanup()
    })

    const path = '/admin/api/cms/data/tables/posts/access'

    it('reads public by default, saves a rule behind step-up and records it', async () => {
      expect(await (await h.cms(path, { cookie: owner })).json()).toEqual({ access: { level: 'public' } })

      const tagged: AccessRule = { level: 'tags', tags: ['student'], onDeny: 'hide' }
      const saved = await h.cms(path, { method: 'PUT', cookie: owner, json: { access: tagged } })
      expect(saved.status).toBe(200)
      expect(await (await h.cms(path, { cookie: owner })).json()).toEqual({ access: tagged })

      const { rows } = await h.db<{ action: string }>`select action from audit_events where action = 'data.table.access'`
      expect(rows).toHaveLength(1)
    })

    it('refuses a rule nobody could pass, a malformed one, and a user who cannot manage tables', async () => {
      const reserved = await h.cms(path, {
        method: 'PUT', cookie: owner, json: { access: { level: 'tags', tags: ['instatic:locked'], onDeny: 'hide' } },
      })
      expect(reserved.status).toBe(400)
      const malformed = await h.cms(path, { method: 'PUT', cookie: owner, json: { access: { level: 'everyone' } } })
      expect(malformed.status).toBe(400)

      const reader = await h.createRoleUser({ name: 'Reader', slug: 'reader', capabilities: ['data.system.tables.read'] })
      const denied = await h.cms(path, { method: 'PUT', cookie: reader.cookie, json: { access: { level: 'members', onDeny: 'login' } } })
      expect(denied.status).toBe(403)
      expect(await (await h.cms(path, { cookie: owner })).json()).toEqual({ access: { level: 'public' } })
    })
  })
})
