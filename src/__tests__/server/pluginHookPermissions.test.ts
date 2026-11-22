/**
 * Plugin hooks and filters are held to the plugin's granted permissions.
 *
 * REAL plugin workers on a real database, driven through the production
 * paths (admin row saves, a branch preview render, the media URL chain).
 * Three plugins that differ only in what they were granted:
 *
 *   - `acme.hooksonly` — the hooks permission and nothing about content;
 *   - `acme.reader`    — may read `posts`;
 *   - `acme.editor`    — may read and write `posts`.
 *
 * None of them may touch `pages`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginManifest } from '@core/plugins/manifest'
import { hookBus } from '@core/plugins/hookBus'
import type { PluginManifest } from '@core/plugin-sdk'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import { loadPluginInWorker, runLifecycleInWorker, runRouteInWorker } from '../../../server/plugins/host/rpc'
import { resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { installPlugin } from '../../../server/repositories/plugins'
import {
  createDataRow,
  createDataTable,
  getDataRow,
  listDataRows,
  saveDataRowDraft,
} from '../../../server/repositories/data'
import { setTableAccess } from '../../../server/publish/tableAccess'
import { pageToCells } from '../../core/data/pageFromRow'
import type { Page } from '@core/page-tree'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { republishAllPages } from '../../../server/publish/republish'
import { handleServerRequest } from '../../../server/router'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const HOOKS_ONLY = 'acme.hooksonly'
const READER = 'acme.reader'
const EDITOR = 'acme.editor'
const MEMBER_READER = 'acme.memberreader'
const WRITER = 'acme.writer'

/**
 * Tries every hook and filter, remembers which registrations were refused and
 * everything it was handed, and serves that back. Its cells filter stamps the
 * title so a persisted change is visible.
 */
const SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  __plugin_exports.activate = async function activate(api) {
    const seen = { refused: {}, cells: [], events: [], html: [], publishes: [] };
    async function attempt(name, register) {
      try { await register(); } catch (e) { seen.refused[name] = e.message; }
    }
    await attempt('content.entry.cells', function () {
      return api.cms.hooks.filter('content.entry.cells', function (cells, ctx) {
        seen.cells.push({ table: ctx.tableSlug, title: cells.title, branch: ctx.branch });
        return Object.assign({}, cells, { title: 'stamped by ' + api.plugin.id });
      });
    });
    for (const event of ['content.entry.created', 'content.entry.updated', 'content.entry.deleted']) {
      await attempt(event, function () {
        return api.cms.hooks.on(event, function (payload) {
          seen.events.push({ event: event, table: payload.tableSlug });
        });
      });
    }
    for (const event of ['publish.before', 'publish.after']) {
      await attempt(event, function () {
        return api.cms.hooks.on(event, function (payload) { seen.publishes.push(event + ':' + payload.pageId); });
      });
    }
    await attempt('publish.html', function () {
      return api.cms.hooks.filter('publish.html', function (html) { seen.html.push(html); return html; });
    });
    await attempt('media.url.transform', function () {
      return api.cms.hooks.filter('media.url.transform', function (value) {
        return { path: 'https://elsewhere.example' + value.path, ctx: value.ctx };
      });
    });
    await attempt('made.up.event', function () { return api.cms.hooks.on('made.up.event', function () {}); });
    await attempt('made.up.filter', function () { return api.cms.hooks.filter('made.up.filter', function (v) { return v; }); });
    await attempt('plugin.acme.other.news', function () {
      return api.cms.hooks.on('plugin.acme.other.news', function () {});
    });
    api.cms.routes.public.get('/seen', function () { return seen; });
  };
})();
`

/** May write `posts` and not read it: reports what its own writes are answered with. */
const WRITER_SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  __plugin_exports.activate = async function activate(api) {
    const posts = api.cms.content.table('posts');
    function idOf(ctx) { return /[?&]id=([^&]+)/.exec(ctx.req.url)[1]; }
    async function message(work) { try { return await work(); } catch (e) { return { refused: e.message }; } }
    api.cms.routes.public.get('/update', function (req) {
      return message(function () { return posts.update(idOf(req), { cells: { title: 'Retitled by the writer' } }); });
    });
    api.cms.routes.public.get('/update-many', function (req) {
      return message(function () { return posts.updateMany([{ id: idOf(req), patch: { cells: { title: 'Again' } } }]); });
    });
    api.cms.routes.public.get('/create', function () {
      return message(function () { return posts.create({ cells: { title: 'Made by the writer' } }); });
    });
    api.cms.routes.public.get('/tree', function (req) {
      return message(function () { return api.cms.content.tree(idOf(req), 'body').mutate([]); });
    });
  };
})();
`

interface Seen {
  refused: Record<string, string>
  cells: Array<{ table: string; title: unknown; branch: boolean }>
  events: Array<{ event: string; table: string }>
  html: string[]
  publishes: string[]
}

function fixture(id: string, extra: { permissions: string[]; contentAccess?: unknown[] }): PluginManifest {
  const permissions = ['cms.hooks', 'cms.routes', 'cms.routes.public', ...extra.permissions]
  return {
    ...parsePluginManifest({
      id,
      name: id,
      version: '1.0.0',
      apiVersion: 1,
      permissions,
      ...(extra.contentAccess ? { contentAccess: extra.contentAccess } : {}),
    }),
    grantedPermissions: permissions,
  } as PluginManifest
}

let harness: CapabilityTestHarness
let owner = ''
let dir = ''

async function load(manifest: PluginManifest, source = SOURCE): Promise<void> {
  const pluginDir = join(dir, manifest.id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'index.js'), source)
  await installPlugin(harness.db, manifest)
  const loaded = await loadPluginInWorker({
    manifest,
    entryFileUrl: join(pluginDir, 'index.js'),
    assetRootPath: pluginDir,
    settings: {},
  })
  if (!loaded.ok) throw new Error(loaded.error ?? `load of ${manifest.id} failed`)
  await runLifecycleInWorker(manifest.id, 'activate')
}

async function seenBy(pluginId: string): Promise<Seen> {
  const res = await runRouteInWorker({
    pluginId,
    method: 'GET',
    path: '/seen',
    request: new Request(`https://site.example/_instatic/plugins/${pluginId}/seen`),
    user: null,
    member: null,
    app: null,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Seen
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'instatic-hook-permissions-'))
  harness = await createCapabilityTestHarness({ uploadsDir: dir })
  owner = await harness.setupOwner()
  setPluginHostContext({ db: harness.db, uploadsDir: dir })
  setApiCallDispatcher(dispatchApiCall)
  await load(fixture(HOOKS_ONLY, { permissions: [] }))
  await load(fixture(READER, {
    permissions: ['cms.content.read'],
    contentAccess: [{ table: 'posts', modes: ['read'] }],
  }))
  await load(fixture(MEMBER_READER, { permissions: ['members.read'] }))
  await load(
    fixture(WRITER, { permissions: ['cms.content.write'], contentAccess: [{ table: 'posts', modes: ['write'] }] }),
    WRITER_SOURCE,
  )
  await load(fixture(EDITOR, {
    permissions: ['cms.content.read', 'cms.content.write'],
    contentAccess: [{ table: 'posts', modes: ['read', 'write'] }],
  }))
})

afterAll(async () => {
  await resetPluginWorker()
  for (const id of [HOOKS_ONLY, READER, EDITOR, MEMBER_READER, WRITER]) hostPlugins.delete(id)
  hookBus.reset()
  await harness.cleanup()
  await rm(dir, { recursive: true, force: true })
})

describe('registering a hook or filter', () => {
  it('is refused when the plugin could never be given what it asks for', async () => {
    const hooksOnly = await seenBy(HOOKS_ONLY)
    expect(Object.keys(hooksOnly.refused).sort()).toEqual([
      'content.entry.cells',
      'content.entry.created',
      'content.entry.deleted',
      'content.entry.updated',
      'made.up.event',
      'made.up.filter',
      'media.url.transform',
    ])
    expect(hooksOnly.refused['content.entry.cells']).toContain('cms.content.write')
    expect(hooksOnly.refused['content.entry.updated']).toContain('cms.content.read')
    expect(hooksOnly.refused['media.url.transform']).toContain('registerUrlTransformer')

    // Reading is enough to hear about entries, not to rewrite them.
    const reader = await seenBy(READER)
    expect(Object.keys(reader.refused).sort()).toEqual([
      'content.entry.cells',
      'made.up.event',
      'made.up.filter',
      'media.url.transform',
    ])

    const editor = await seenBy(EDITOR)
    expect(Object.keys(editor.refused).sort()).toEqual(['made.up.event', 'made.up.filter', 'media.url.transform'])
  })

  it('never lets the hooks permission stand in for the media URL permission', async () => {
    const out = await hookBus.applyFilter('media.url.transform', {
      path: '/uploads/a.png',
      ctx: { kind: 'original', originalMimeType: 'image/png' },
    })
    expect(out.path).toBe('/uploads/a.png')
  })
})

describe('entry cells and entry events', () => {
  it('reach a plugin only for a table its content access covers', async () => {
    // A post: the editor may read and write the table, the reader may read it.
    const created = await harness.cms('/admin/api/cms/data/tables/posts/rows', {
      method: 'POST',
      cookie: owner,
      json: { cells: { title: 'Quarterly numbers, unpublished' } },
    })
    expect(created.status).toBe(201)
    const { row: post } = await readJson<{ row: { id: string; cells: Record<string, unknown> } }>(created)
    expect(post.cells.title).toBe(`stamped by ${EDITOR}`)

    // A page: none of the three plugins has access to `pages`.
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const saved = await harness.cms(`/admin/api/cms/data/rows/${home!.id}`, {
      method: 'PATCH',
      cookie: owner,
      json: { cells: { ...home!.cells, title: 'Launch plan, unpublished' } },
    })
    expect(saved.status).toBe(200)
    expect((await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.cells.title).toBe('Launch plan, unpublished')

    const hooksOnly = await seenBy(HOOKS_ONLY)
    expect(hooksOnly.cells).toEqual([])
    expect(hooksOnly.events).toEqual([])

    const reader = await seenBy(READER)
    expect(reader.cells).toEqual([])
    expect(reader.events).toEqual([{ event: 'content.entry.created', table: 'posts' }])

    const editor = await seenBy(EDITOR)
    expect(editor.cells).toEqual([{ table: 'posts', title: 'Quarterly numbers, unpublished', branch: false }])
    expect(editor.events).toEqual([{ event: 'content.entry.created', table: 'posts' }])
  })
})

describe('a save on a branch', () => {
  it('passes through the cells filter of a plugin that may read and write the table, flagged as a branch', async () => {
    const made = await harness.cms('/admin/api/cms/data/tables/posts/rows', {
      method: 'POST',
      cookie: owner,
      json: { cells: { title: 'On main first' } },
    })
    const { row } = await readJson<{ row: { id: string } }>(made)
    expect((await harness.cms('/admin/api/cms/branches', {
      method: 'POST',
      cookie: owner,
      json: { name: 'Quiet Work' },
    })).status).toBe(201)

    const saved = await harness.cms(`/admin/api/cms/data/rows/${row.id}`, {
      method: 'PATCH',
      cookie: owner,
      headers: { 'x-instatic-branch': 'quiet-work' },
      json: { cells: { title: 'Branch draft' } },
    })
    expect(saved.status).toBe(200)

    // A merge brings this row to main without another save: the filter that
    // validates on save has to have seen it here.
    const editor = await seenBy(EDITOR)
    expect(editor.cells.at(-1)).toEqual({ table: 'posts', title: 'Branch draft', branch: true })
    expect(editor.cells.filter((seen) => seen.title === 'On main first')).toEqual([
      { table: 'posts', title: 'On main first', branch: false },
    ])
    expect((await getDataRow(harness.db, { branchId: 'quiet-work' }, row.id))!.cells.title).toBe(`stamped by ${EDITOR}`)
    // Plugins without read and write on the table still see nothing of it.
    expect((await seenBy(READER)).cells).toEqual([])
    expect((await seenBy(HOOKS_ONLY)).cells).toEqual([])
  })
})

describe('a plugin that may write a table and not read it', () => {
  async function asWriter(path: string): Promise<Record<string, unknown>> {
    const res = await runRouteInWorker({
      pluginId: WRITER,
      method: 'GET',
      path: path.split('?')[0]!,
      request: new Request(`https://site.example/_instatic/plugins/${WRITER}${path}`),
      user: null,
      member: null,
      app: null,
    })
    expect(res.status).toBe(200)
    return (await res.json()) as Record<string, unknown>
  }

  it('is answered without the cells it could not have read', async () => {
    const created = await harness.cms('/admin/api/cms/data/tables/posts/rows', {
      method: 'POST',
      cookie: owner,
      json: { cells: { title: 'A post', note: 'Private note, never sent by the plugin' } },
    })
    const { row } = await readJson<{ row: { id: string } }>(created)

    const updated = await asWriter(`/update?id=${row.id}`)
    expect(JSON.stringify(updated)).not.toContain('Private note')
    expect(updated).toMatchObject({ id: row.id, tableSlug: 'posts', cells: {} })
    // The write itself went through.
    expect((await getDataRow(harness.db, MAIN_SCOPE, row.id))!.cells.note).toBe('Private note, never sent by the plugin')

    const many = await asWriter(`/update-many?id=${row.id}`)
    expect(JSON.stringify(many)).not.toContain('Private note')

    // The editor's cells filter stamps the title; the writer is not shown that either.
    const made = await asWriter('/create')
    expect(made).toMatchObject({ tableSlug: 'posts', cells: {} })

    // Changing a tree means addressing its nodes: that needs read as well.
    // (`posts` has no page tree; the refusal is the same either way. Trees on
    // a real page are covered in pluginContentGrant.test.ts.)
    expect((await asWriter(`/tree?id=${row.id}`)).refused).toContain("not found, or not within this plugin's content access")
  })
})

describe('a members-only page', () => {
  it('re-run through the publish pipeline reaches only plugins that may read members', async () => {
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const author = (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.createdByUserId!
    await saveDataRowDraft(harness.db, MAIN_SCOPE, home!.id, {
      cells: { ...home!.cells, title: 'Members-only ledger', access: { level: 'members', onDeny: 'hide' } },
      slug: home!.slug,
    })
    await publishDraftSite(harness.db, author, dir)

    // What `api.cms.content.republishAll()` runs.
    expect(await republishAllPages(harness.db)).toBeGreaterThan(0)

    for (const id of [HOOKS_ONLY, READER, EDITOR]) {
      const seen = await seenBy(id)
      expect(seen.html.join('\n')).not.toContain('Members-only ledger')
      // Not even that the page was rendered.
      expect(seen.publishes.filter((entry) => entry.endsWith(`:${home!.id}`))).toEqual([])
    }
    const reader = await seenBy(MEMBER_READER)
    expect(reader.html.join('\n')).toContain('Members-only ledger')
    expect(reader.publishes).toContain(`publish.before:${home!.id}`)
    expect(reader.publishes).toContain(`publish.after:${home!.id}`)
  })

  it('counts an entry template of a members-only table as members-only', async () => {
    const template = {
      id: 'page_lesson_tpl',
      title: 'Lesson template',
      slug: 'lesson-template',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['line'], classIds: [] },
        line: { id: 'line', moduleId: 'base.text', props: { text: 'Lesson template wording', tag: 'h1' }, breakpointOverrides: {}, children: [], classIds: [] },
      },
      template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 100 },
    } as unknown as Page
    const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const author = (await getDataRow(harness.db, MAIN_SCOPE, home!.id))!.createdByUserId!
    await createDataRow(harness.db, MAIN_SCOPE, {
      id: template.id, tableId: 'pages', cells: pageToCells(template), slug: template.slug,
    }, author)
    await publishDraftSite(harness.db, author, dir)
    expect(await setTableAccess(harness.db, 'posts', { level: 'members', onDeny: 'hide' }, dir)).toBe(true)

    expect(await republishAllPages(harness.db)).toBeGreaterThan(0)

    for (const id of [HOOKS_ONLY, READER, EDITOR]) {
      expect((await seenBy(id)).html.join('\n')).not.toContain('Lesson template wording')
    }
    expect((await seenBy(MEMBER_READER)).html.join('\n')).toContain('Lesson template wording')
  })
})

describe('a page protected only by where it sits', () => {
  it('under a members-only table\'s address is members-only for a background re-render too', async () => {
    // No access rule on the page itself: the table whose route base its
    // address sits under is what the public router holds it to.
    await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'club', name: 'Club', slug: 'club', kind: 'postType', routeBase: '/club',
      singularLabel: 'Note', pluralLabel: 'Notes',
    })
    const page = {
      id: 'page_club_intro',
      title: 'Club intro',
      slug: 'club/intro',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: ['line'], classIds: [] },
        line: { id: 'line', moduleId: 'base.text', props: { text: 'Path-protected wording', tag: 'h1' }, breakpointOverrides: {}, children: [], classIds: [] },
      },
    } as unknown as Page
    const [first] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const author = (await getDataRow(harness.db, MAIN_SCOPE, first!.id))!.createdByUserId!
    await createDataRow(harness.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, author)
    expect(await setTableAccess(harness.db, 'club', { level: 'members', onDeny: 'hide' }, dir)).toBe(true)
    // Publishing bakes public pages to disk through the same pipeline: this
    // one is not public, so it is neither baked nor shown to a filter.
    await publishDraftSite(harness.db, author, dir)
    expect(await Bun.file(join(dir, 'published', 'current')).exists()).toBe(true)
    const slot = (await Bun.file(join(dir, 'published', 'current')).text()).trim()
    expect(await Bun.file(join(dir, 'published', slot, 'club', 'intro.html')).exists()).toBe(false)

    // The public router refuses it to a visitor who is not signed in.
    const visit = await handleServerRequest(new Request('http://localhost/club/intro', { redirect: 'manual' }), {
      db: harness.db,
      uploadsDir: dir,
    })
    expect(visit.status).not.toBe(200)

    expect(await republishAllPages(harness.db)).toBeGreaterThan(0)
    for (const id of [HOOKS_ONLY, READER, EDITOR]) {
      expect((await seenBy(id)).html.join('\n')).not.toContain('Path-protected wording')
    }
    expect((await seenBy(MEMBER_READER)).html.join('\n')).toContain('Path-protected wording')
  })
})

describe('a preview of unpublished work', () => {
  it('is not handed to plugin HTML filters', async () => {
    expect((await harness.cms('/admin/api/cms/branches', {
      method: 'POST',
      cookie: owner,
      json: { name: 'Hook Preview' },
    })).status).toBe(201)
    const scope = { branchId: 'hook-preview' }
    const home = (await listDataRows(harness.db, scope, 'pages')).find((row) => row.slug === 'index')
    await saveDataRowDraft(harness.db, scope, home!.id, {
      cells: { ...home!.cells, title: 'Branch-only headline' },
      slug: home!.slug,
    })
    const issued = await harness.cms('/admin/api/cms/branches/hook-preview/preview', { method: 'POST', cookie: owner })
    expect(issued.status).toBe(201)
    const { url } = await readJson<{ url: string }>(issued)
    const entry = await handleServerRequest(new Request(`http://localhost${new URL(url).pathname}`, { redirect: 'manual' }), {
      db: harness.db,
    })
    const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const request = new Request('http://localhost/', { redirect: 'manual' })
    request.headers.set('cookie', cookie)
    const previewed = await handleServerRequest(request, { db: harness.db })
    expect(previewed.status).toBe(200)
    // The admin with the link sees the draft.
    expect(await previewed.text()).toContain('Branch-only headline')

    for (const id of [HOOKS_ONLY, READER, EDITOR, MEMBER_READER]) {
      const before = (await seenBy(id)).publishes.length
      const again = new Request('http://localhost/', { redirect: 'manual' })
      again.headers.set('cookie', cookie)
      expect((await handleServerRequest(again, { db: harness.db })).status).toBe(200)
      const { html, refused, publishes } = await seenBy(id)
      expect(refused['publish.html']).toBeUndefined()
      expect(html.join('\n')).not.toContain('Branch-only headline')
      // A preview is not a publish: no publish event goes out for it.
      expect(publishes.length).toBe(before)
    }
  })
})
