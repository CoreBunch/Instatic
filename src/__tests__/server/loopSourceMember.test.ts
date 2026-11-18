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
import { requestForPluginSource } from '../../../server/plugins/host/handlers/loops'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { handleServerRequest } from '../../../server/router'
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
  if (!request || !('member' in request) || request.member === undefined) return 'member=absent'
  if (request.member === null) return 'member=signed-out'
  const { id: _id, ...rest } = request.member
  return `member=${JSON.stringify(rest)}`
}

function source(id: string, flags: Pick<LoopEntitySource, 'perVisitor' | 'requestDependent'>): LoopEntitySource {
  return {
    id,
    label: id,
    ...flags,
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'label', label: 'Label' }],
    fetch: async (ctx: SourceFetchContext) => ({
      items: [{ id: '1', fields: { label: describeMember(ctx.request) } }],
      totalItems: 1,
    }),
    preview: () => [],
  }
}

function loop(id: string, sourceId: string, children: string[]): Node {
  return node(id, 'base.loop', {
    sourceId, filters: {}, orderBy: '', direction: 'asc', limit: 10, offset: 0,
    pagination: 'none', pageSize: 10, tag: 'div', customTag: '',
  }, children)
}

/**
 * A public page with a per-visitor list, a shared list, and a shared list
 * whose item holds a per-visitor list.
 */
function homePage(): Page {
  const nodes = [
    node('root', 'base.body', {}, ['who', 'shared', 'outer']),
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
    const page = homePage()
    await createDataRow(t.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, 'admin_1')
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
    return `instatic_member=${session.token}`
  }

  async function hole(nodeId: string, cookie?: string): Promise<Response> {
    const index = await getPublishedNodeIndexForVersion(t.db, getPublishVersion())
    return get(`/_instatic/hole/${nodeId}?v=${index!.snapshotHash}&u=${encodeURIComponent('/')}`, cookie)
  }

  it('tells a per-visitor source who is signed in, on a page anyone can open', async () => {
    const ada = await signedIn('ada@example.com', 'Ada', ['pro'])
    const res = await hole('who', ada)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const html = (await res.text()).replaceAll('&quot;', '"')
    expect(html).toContain('WHO[member={"email":"ada@example.com","tags":["pro"],"profile":{"name":"Ada"}}]')
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
    expect(html).toContain('WHO[member=signed-out]')
    expect(html).not.toContain('example.com')
  })

  it('tells a shared source nothing, so a member cannot enter a cached fragment', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const first = await (await hole('shared', ada)).text()
    expect(first).toContain('SHARED[member=absent]')
    // The fragment Ada's request filled the cache with is what everyone gets.
    expect(await (await hole('shared')).text()).toBe(first)
  })

  it('tells a per-visitor list inside a shared fragment nothing either', async () => {
    const ada = await signedIn('ada@example.com', 'Ada')
    const html = await (await hole('outer', ada)).text()
    expect(html).toContain('INNER[member=absent]')
    expect(html).not.toContain('example.com')
    expect(await (await hole('outer')).text()).toBe(html)
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
    expect(all).not.toContain('member=')
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

  it('leaves the member out for a source that is not per-visitor, whatever it was handed', () => {
    grant(['loops.register', 'members.read'])
    const sent = requestForPluginSource('acme.shop', false, request)
    expect(sent && 'member' in sent).toBe(false)
  })

  it('sends no request at publish time', () => {
    grant(['loops.register', 'members.read'])
    expect(requestForPluginSource('acme.shop', true, undefined)).toBeUndefined()
  })
})
