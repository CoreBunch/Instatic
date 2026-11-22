/**
 * The signed-in member and per-visitor loop sources.
 *
 * A per-visitor source learns who the visitor is; nothing else does. These
 * tests publish a real site, sign real members in and ask the fragment
 * endpoint, so they cover the two things that must hold together:
 *   - the member reaches a per-visitor source, on a public page too;
 *   - nothing about a member reaches a fragment that is shared (Layer B) or
 *     a file in the static slot.
 * The last block covers what a plugin's source is sent.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, SiteShell } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopEntitySource, SourceFetchContext, SourceRequestContext } from '@core/loops/types'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageToCells } from '../../core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createMember, grantMemberTag } from '../../../server/members/repository'
import { createMemberSession } from '../../../server/members/sessions'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { requestForPluginSource } from '../../../server/plugins/host/handlers/loops'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { unloadPlugin } from '../../../server/plugins/runtime'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { sourceRequestFor, type LoopRequestScope } from '../../../server/publish/loopSourceRequest'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const ORIGIN = 'http://localhost'
const WHO = 'test.member.who'
const SHARED = 'test.member.shared'

type Node = Page['nodes'][string]

function node(id: string, moduleId: string, props: Record<string, unknown>, children: string[] = []): Node {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] } as Node
}

function makeShell(): SiteShell {
  return {
    id: 'site_1',
    name: 'Loop Member Site',
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

/** What a source was told about the visitor, as one line of text. */
function describeMember(request: SourceRequestContext | undefined): string {
  if (!request) return 'request=absent'
  const cookies = `cookies=${Object.keys(request.cookies).length}`
  if (!('member' in request) || request.member === undefined) return `member=absent ${cookies}`
  if (request.member === null) return `member=signed-out ${cookies}`
  const { id: _id, ...rest } = request.member
  return `member=${JSON.stringify(rest)} ${cookies}`
}

function source(id: string, flags: Pick<LoopEntitySource, 'perVisitor' | 'requestDependent'>): LoopEntitySource {
  return {
    id,
    label: id,
    ...flags,
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'label', label: 'Label' }],
    // The per-visitor source has three items, so a paged list has a second page.
    fetch: async (ctx: SourceFetchContext) => {
      const total = flags.perVisitor ? 3 : 1
      const label = describeMember(ctx.request)
      const items = Array.from({ length: total }, (_, i) => ({ id: String(i), fields: { label: `${label} #${i}` } }))
      return { items: items.slice(ctx.offset, ctx.offset + ctx.limit), totalItems: total }
    },
    preview: () => [],
  }
}

function loop(id: string, sourceId: string, children: string[], paged = false): Node {
  return node(id, 'base.loop', {
    sourceId, filters: {}, orderBy: '', direction: 'asc', limit: 10, offset: 0,
    pagination: paged ? 'infinite' : 'none', pageSize: paged ? 1 : 10, tag: 'div', customTag: '',
  }, children)
}

/** A header component whose menu is a per-visitor list. */
const MENU_BODY = {
  rootNodeId: 'vc_root',
  nodes: Object.fromEntries(
    [
      node('vc_root', 'base.container', {}, ['vc_loop']),
      loop('vc_loop', WHO, ['vc_item']),
      node('vc_item', 'base.text', { text: 'MENU[{currentEntry.label}]', tag: 'p' }),
    ].map((entry) => [entry.id, entry]),
  ),
}

/**
 * A public page with a per-visitor list, a shared list, and a shared list
 * whose item holds a per-visitor list.
 */
function homePage(): Page {
  const nodes = [
    node('root', 'base.body', {}, ['who', 'shared', 'outer', 'paged', 'header', 'static_outer', 'mixed']),
    loop('paged', WHO, ['paged_item'], true),
    node('paged_item', 'base.text', { text: 'PAGED[{currentEntry.label}]', tag: 'p' }),
    node('header', 'base.visual-component-ref', { componentId: 'vc_menu' }),
    loop('static_outer', 'site.pages', ['static_inner']),
    loop('static_inner', WHO, ['static_item']),
    node('static_item', 'base.text', { text: 'STATIC[{currentEntry.label}]', tag: 'p' }),
    loop('mixed', WHO, ['mixed_item', 'mixed_inner']),
    node('mixed_item', 'base.text', { text: 'MIXED[{currentEntry.label}]', tag: 'p' }),
    loop('mixed_inner', SHARED, ['mixed_inner_item']),
    node('mixed_inner_item', 'base.text', { text: 'BESIDE[{currentEntry.label}]', tag: 'p' }),
    loop('who', WHO, ['who_item']),
    node('who_item', 'base.text', { text: 'WHO[{currentEntry.label}]', tag: 'p' }),
    loop('shared', SHARED, ['shared_item']),
    node('shared_item', 'base.text', { text: 'SHARED[{currentEntry.label}]', tag: 'p' }),
    loop('outer', SHARED, ['inner']),
    loop('inner', WHO, ['inner_item']),
    node('inner_item', 'base.text', { text: 'INNER[{currentEntry.label}]', tag: 'p' }),
  ]
  return {
    id: 'page_home', title: 'Home', slug: 'index', rootNodeId: 'root',
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
  } as Page
}

describe('the signed-in member and per-visitor loop sources', () => {
  let t: TestDb
  let uploadsDir: string

  beforeEach(async () => {
    resetForTests()
    loopSourceRegistry.registerOrReplace(source(WHO, { perVisitor: true }))
    loopSourceRegistry.registerOrReplace(source(SHARED, { requestDependent: true }))
    t = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'loop-member-'))
    await t.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values ('admin_1', 'admin@example.test', 'admin@example.test', 'Admin', 'x', 'owner')
    `
    await saveDraftSite(t.db, MAIN_SCOPE, makeShell())
    await createDataRow(t.db, MAIN_SCOPE, {
      id: 'vc_menu', tableId: 'components', slug: 'menu', cells: { name: 'Menu', body: MENU_BODY, params: [], classIds: [] },
    }, 'admin_1')
    const account = {
      id: 'page_account', title: 'Account', slug: 'account', rootNodeId: 'root',
      nodes: {
        root: node('root', 'base.body', {}, ['acct_header']),
        acct_header: node('acct_header', 'base.visual-component-ref', { componentId: 'vc_menu' }),
      },
      access: { level: 'members', onDeny: 'login' },
    } as unknown as Page
    for (const page of [homePage(), account]) {
      await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
    }
    await publishDraftSite(t.db, 'admin_1', uploadsDir)
  })

  afterEach(async () => {
    loopSourceRegistry.unregister(WHO)
    loopSourceRegistry.unregister(SHARED)
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
    return `instatic_member=${session.token}; theme=dark`
  }

  async function hole(nodeId: string, cookie?: string, path = '/'): Promise<Response> {
    const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
    return get(`/_instatic/hole/${nodeId}?v=${index!.snapshotHash}&u=${encodeURIComponent(path)}`, cookie)
  }

  const text = async (res: Promise<Response>) => (await (await res).text()).replaceAll('&quot;', '"')

  it('tells a per-visitor source who is signed in, on a page anyone can open', async () => {
    const ada = await signedIn('ada@example.com', 'Ada', ['pro'])
    const res = await hole('who', ada)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const html = (await res.text()).replaceAll('&quot;', '"')
    expect(html).toContain('WHO[member={"email":"ada@example.com","tags":["pro"],"profile":{"name":"Ada"}} cookies=1 #0]')
  })

  it('tells it the visitor is signed out, and gives each visitor their own answer', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const bob = await signedIn('bob@example.com', 'Bob')
    expect(await (await hole('who', ada)).text()).toContain('ada@example.com')
    const forBob = await (await hole('who', bob)).text()
    expect(forBob).toContain('bob@example.com')
    expect(forBob).not.toContain('ada@example.com')
    const anonymous = await hole('who')
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store')
    const html = await anonymous.text()
    expect(html).toContain('WHO[member=signed-out cookies=0 #0]')
    expect(html).not.toContain('example.com')
  })

  it('tells a shared source nothing, so a member cannot enter a cached fragment', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const first = await (await hole('shared', ada)).text()
    expect(first).toContain('SHARED[member=absent cookies=0 #0]')
    // The fragment Ada's request filled the cache with is what everyone gets.
    expect(await (await hole('shared')).text()).toBe(first)
  })

  it('renders a fragment for one visitor when a list nested in a shared list is per-visitor', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const res = await hole('outer', ada)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const html = (await res.text()).replaceAll('&quot;', '"')
    expect(html).toContain('INNER[member={"email":"ada@example.com"')
    // Nothing of Ada's is kept for the next visitor.
    const anonymous = await text(hole('outer'))
    expect(anonymous).toContain('INNER[member=signed-out cookies=0 #0]')
    expect(anonymous).not.toContain('example.com')
  })

  it('does the same for a per-visitor list inside a baked list', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const res = await hole('static_outer', ada)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect((await res.text()).replaceAll('&quot;', '"')).toContain('STATIC[member={"email":"ada@example.com"')
    const anonymous = await text(hole('static_outer'))
    expect(anonymous).toContain('STATIC[member=signed-out')
    expect(anonymous).not.toContain('example.com')
  })

  it('does the same for an account menu inside a header component, on a public and a protected page', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const bob = await signedIn('bob@example.com', 'Bob')
    const onHome = await hole('header', ada)
    expect(onHome.headers.get('cache-control')).toBe('private, no-store')
    expect((await onHome.text()).replaceAll('&quot;', '"')).toContain('MENU[member={"email":"ada@example.com"')
    const forBob = await text(hole('header', bob))
    expect(forBob).toContain('bob@example.com')
    expect(forBob).not.toContain('ada@example.com')
    expect(await text(hole('header'))).toContain('MENU[member=signed-out cookies=0 #0]')

    const onAccount = await text(hole('acct_header', ada, '/account'))
    expect(onAccount).toContain('MENU[member={"email":"ada@example.com"')
    expect((await hole('acct_header', undefined, '/account')).status).toBe(404)
  })

  it('tells a shared source beside a per-visitor one nothing, in the same fragment', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const html = await text(hole('mixed', ada))
    expect(html).toContain('MIXED[member={"email":"ada@example.com"')
    expect(html).toContain('BESIDE[member=absent cookies=0 #0]')
  })

  it('tells a per-visitor list the same on its later pages', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const page = (cookie?: string) => get(`/_instatic/loop/paged?page=2&pagePath=${encodeURIComponent('/')}`, cookie)
    const res = await page(ada)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const body = (await res.json()) as { html: string; hasMore: boolean }
    expect(body.html.replaceAll('&quot;', '"')).toContain('PAGED[member={"email":"ada@example.com","tags":[],"profile":{"name":"Ada"}} cookies=1 #1]')
    expect(body.hasMore).toBe(true)
    const anonymous = await page()
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store')
    expect(((await anonymous.json()) as { html: string }).html).toContain('PAGED[member=signed-out cookies=0 #1]')
  })

  it('writes nothing about a member to the static slot', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    await hole('who', ada)
    await get('/', ada)
    let all = ''
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else all += await Bun.file(full).text().catch(() => '')
      }
    }
    await walk(uploadsDir)
    expect(all).toContain('data-instatic-hole="who"')
    expect(all).not.toContain('ada@example.com')
    expect(all).not.toContain('member={')
    expect(all).not.toContain('member=signed-out')
  })
})

describe('what a plugin loop source is sent', () => {
  const request: SourceRequestContext = {
    query: {}, path: '/', slug: null, cookies: { theme: 'dark' },
    member: { id: 'm1', email: 'ada@example.com', tags: ['pro'], profile: { name: 'Ada' } },
  }
  const grant = (permissions: string[]) =>
    hostPlugins.set('acme.shop', { manifest: { id: 'acme.shop', grantedPermissions: permissions } } as never)

  afterEach(() => {
    hostPlugins.delete('acme.shop')
  })

  it('includes the member for a per-visitor source of a plugin that may read members', () => {
    grant(['loops.register', 'members.read'])
    expect(requestForPluginSource('acme.shop', true, request)).toEqual(request)
    expect(requestForPluginSource('acme.shop', true, { ...request, member: null })?.member).toBeNull()
  })

  it('leaves the member out without the permission, keeping the rest', () => {
    grant(['loops.register'])
    const sent = requestForPluginSource('acme.shop', true, request)
    expect(sent).toEqual({ query: {}, path: '/', slug: null, cookies: { theme: 'dark' } })
    expect(sent && 'member' in sent).toBe(false)
  })

  it('leaves the member and the cookies out for a source that is not per-visitor, whatever it was handed', () => {
    grant(['loops.register', 'members.read'])
    const sent = requestForPluginSource('acme.shop', false, request)
    expect(sent).toEqual({ query: {}, path: '/', slug: null, cookies: {} })
  })

  it('sends no request at publish time', () => {
    grant(['loops.register', 'members.read'])
    expect(requestForPluginSource('acme.shop', true, undefined)).toBeUndefined()
  })
})

describe('the request built for one source', () => {
  const base = { query: { q: 'x' }, path: '/account', slug: 'account' }
  const ada = { id: 'm1', email: 'ada@example.com', tags: [], profile: {} }

  function scopeCounting(): { scope: LoopRequestScope; lookups: () => number } {
    let lookups = 0
    return {
      scope: { base, visitor: { cookies: { theme: 'dark' }, member: async () => { lookups++; return ada } } },
      lookups: () => lookups,
    }
  }

  it('gives a per-visitor source the cookies and the member', async () => {
    const { scope, lookups } = scopeCounting()
    expect(await sourceRequestFor({ perVisitor: true }, scope)).toEqual({ ...base, cookies: { theme: 'dark' }, member: ada })
    expect(lookups()).toBe(1)
  })

  it('gives any other source neither, and does not look the member up', async () => {
    const { scope, lookups } = scopeCounting()
    expect(await sourceRequestFor({}, scope)).toEqual({ ...base, cookies: {} })
    expect(await sourceRequestFor({ perVisitor: false, mayKnowMember: () => true }, scope)).toEqual({ ...base, cookies: {} })
    expect(lookups()).toBe(0)
  })

  it('does not look the member up for a per-visitor source that may not know them', async () => {
    const { scope, lookups } = scopeCounting()
    const sent = await sourceRequestFor({ perVisitor: true, mayKnowMember: () => false }, scope)
    expect(sent).toEqual({ ...base, cookies: { theme: 'dark' } })
    expect('member' in sent).toBe(false)
    expect(lookups()).toBe(0)
  })

  it('says nobody is signed in when the render has no visitor, as in a preview', async () => {
    expect(await sourceRequestFor({ perVisitor: true }, { base })).toEqual({ ...base, cookies: {}, member: null })
  })
})

describe('a plugin\'s loop sources on the published site', () => {
  const PLUGIN_ID = 'acme.club'
  // At publish time there is no request; the list is a hole and this answer is never baked.
  const tell = `(ctx) => {
    const request = ctx.request || { cookies: {} }
    return {
      items: [{ id: '1', fields: { label: JSON.stringify({
        member: request.member === undefined ? 'absent' : request.member && request.member.email,
        cookies: Object.keys(request.cookies),
      }) } }],
      totalItems: 1,
    }
  }`
  const PLUGIN_SOURCE = `
    export async function activate(api) {
      const common = { filterSchema: {}, orderByOptions: [], fields: [{ id: 'label', label: 'Label' }], preview: () => [] }
      await api.cms.loops.registerSource({ ...common, id: 'acme.club.mine', label: 'Mine', perVisitor: true, fetch: ${tell} })
      await api.cms.loops.registerSource({ ...common, id: 'acme.club.news', label: 'News', requestDependent: true, fetch: ${tell} })
    }
  `
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string

  beforeEach(async () => {
    resetForTests()
    uploadsDir = await mkdtemp(join(tmpdir(), 'loop-member-plugin-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
  })

  afterEach(async () => {
    // The loop registry is one per process: unload the plugin so its sources
    // and its worker do not outlive this test into whichever file runs next.
    await unloadPlugin(PLUGIN_ID)
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(permissions: string[]): Promise<void> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify({
        id: PLUGIN_ID, name: 'Club', version: '1.0.0', apiVersion: 1, permissions,
        entrypoints: { server: 'server/index.js' }, resources: [], adminPages: [],
      })),
      'server/index.js': strToU8(PLUGIN_SOURCE),
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
    expect((await handleCmsRequest(req, h.db, { uploadsDir })).status).toBe(201)
  }

  /** Publishes a page with one list per source and returns a reader for each fragment. */
  async function publish(): Promise<(nodeId: string, cookie?: string) => Promise<{ member: unknown; cookies: string[] }>> {
    const { rows } = await h.db<{ id: string }>`select id from users limit 1`
    const userId = rows[0]!.id
    await saveDraftSite(h.db, MAIN_SCOPE, makeShell())
    const nodes = [
      node('root', 'base.body', {}, ['mine', 'news']),
      loop('mine', 'acme.club.mine', ['mine_item']),
      node('mine_item', 'base.text', { text: '{currentEntry.label}', tag: 'p' }),
      loop('news', 'acme.club.news', ['news_item']),
      node('news_item', 'base.text', { text: '{currentEntry.label}', tag: 'p' }),
    ]
    const page = {
      id: 'page_club', title: 'Club', slug: 'club', rootNodeId: 'root',
      nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    } as Page
    await createDataRow(h.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, userId)
    await publishDraftSite(h.db, userId, uploadsDir)
    const index = await getPublishedNodeIndexForVersion(h.db, getPublishVersion())
    return async (nodeId, cookie) => {
      const req = new Request(`${ORIGIN}/_instatic/hole/${nodeId}?v=${index!.snapshotHash}&u=${encodeURIComponent('/club')}`)
      if (cookie) req.headers.set('cookie', cookie)
      const html = await (await handleServerRequest(req, { db: h.db, uploadsDir })).text()
      const json = html.replaceAll('&quot;', '"').match(/\{.*\}/)
      return JSON.parse(json![0]) as { member: unknown; cookies: string[] }
    }
  }

  async function ada(): Promise<string> {
    const member = await createMember(h.db, { email: 'ada@example.com', passwordHash: null, profile: { name: 'Ada' }, verified: true })
    const session = await createMemberSession(h.db, member!.id, { ipAddress: null, userAgent: null })
    return `instatic_member=${session.token}; theme=dark`
  }

  it('tells a per-visitor source the member when the plugin may read members, and a shared source nothing', async () => {
    await install(['loops.register', 'members.read'])
    const fragment = await publish()
    const cookie = await ada()
    expect(await fragment('mine', cookie)).toEqual({ member: 'ada@example.com', cookies: ['theme'] })
    expect(await fragment('mine')).toEqual({ member: null, cookies: [] })
    expect(await fragment('news', cookie)).toEqual({ member: 'absent', cookies: [] })
  })

  it('tells it the cookies and no member when the plugin may not', async () => {
    await install(['loops.register'])
    const fragment = await publish()
    expect(await fragment('mine', await ada())).toEqual({ member: 'absent', cookies: ['theme'] })
  })
})
