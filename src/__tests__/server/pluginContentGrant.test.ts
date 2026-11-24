/**
 * `api.cms.content.*` stays inside the plugin's grant.
 *
 * One REAL plugin worker on a real database. `acme.mover` may write `posts`
 * and `pages` without reading them, and may read and write its own `inbox`
 * table. Every call below is one it should not be able to use to read, or to
 * change, what its grant does not cover.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { PluginManifest } from '@core/plugin-sdk'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import { loadPluginInWorker, runLifecycleInWorker, runRouteInWorker } from '../../../server/plugins/host/rpc'
import { resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { createDataRow, createDataTable, getDataRow, listDataRows, saveDataRowDraft } from '../../../server/repositories/data'
import { installPlugin } from '../../../server/repositories/plugins'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const MOVER = 'acme.mover'
const PERMISSIONS = ['cms.routes', 'cms.routes.public', 'cms.content.read', 'cms.content.write']

/** One route per call; each answers `{ ok }` or `{ refused: message }`. */
const SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  __plugin_exports.activate = async function activate(api) {
    const content = api.cms.content;
    function arg(ctx, name) {
      const found = new RegExp('[?&]' + name + '=([^&]+)').exec(ctx.req.url);
      return found ? decodeURIComponent(found[1]) : undefined;
    }
    function route(path, work) {
      api.cms.routes.public.get(path, async function (ctx) {
        try { return { ok: await work(ctx) }; } catch (e) { return { refused: e.message }; }
      });
    }
    route('/can-move', function () { return typeof content.table('posts').moveToTable; });
    route('/update', function (ctx) {
      return content.table(arg(ctx, 'table')).update(arg(ctx, 'id'), { cells: JSON.parse(arg(ctx, 'cells')) });
    });
    route('/create', function (ctx) {
      return content.table(arg(ctx, 'table')).create({ cells: { title: 'Made by the mover' }, slug: arg(ctx, 'slug') });
    });
    route('/search', function (ctx) { return content.search(arg(ctx, 'q'), 50); });
    route('/tables', function () { return content.tables.list(); });
    route('/table', function (ctx) { return content.tables.get(arg(ctx, 'slug')); });
    route('/tree-read', function (ctx) { return content.tree(arg(ctx, 'id'), arg(ctx, 'field')).read(); });
    route('/tree-mutate', function (ctx) { return content.tree(arg(ctx, 'id'), arg(ctx, 'field')).mutate([]); });
    route('/tree-replace', function (ctx) {
      return content.tree(arg(ctx, 'id'), arg(ctx, 'field')).replace({
        rootNodeId: 'root',
        nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
      });
    });
  };
})();
`

interface Answer {
  ok?: unknown
  refused?: string
}

let harness: CapabilityTestHarness
let dir = ''
let homeId = ''

async function ask(path: string, query: Record<string, string> = {}): Promise<Answer> {
  const search = new URLSearchParams(query).toString()
  const res = await runRouteInWorker({
    pluginId: MOVER,
    method: 'GET',
    path,
    request: new Request(`https://site.example/_instatic/plugins/${MOVER}${path}${search ? `?${search}` : ''}`),
    user: null,
    member: null,
    app: null,
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Answer
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'instatic-content-grant-'))
  harness = await createCapabilityTestHarness({ uploadsDir: dir })
  await harness.setupOwner()
  await createDataTable(harness.db, MAIN_SCOPE, {
    id: 'inbox', name: 'Inbox', slug: 'inbox', kind: 'postType', routeBase: '/inbox',
    singularLabel: 'Item', pluralLabel: 'Items',
  })
  await createDataTable(harness.db, MAIN_SCOPE, {
    id: 'ledger', name: 'Ledger', slug: 'ledger', kind: 'postType', routeBase: '/ledger',
    singularLabel: 'Line', pluralLabel: 'Lines',
  })
  await createDataRow(harness.db, MAIN_SCOPE, {
    id: 'post_private', tableId: 'posts',
    cells: { title: 'Zebra forecast', slug: 'zebra-forecast', note: 'PRIVATE-NOTE' }, slug: 'zebra-forecast',
  }, null)
  await createDataRow(harness.db, MAIN_SCOPE, {
    id: 'ledger_1', tableId: 'ledger', cells: { title: 'Zebra ledger line', slug: 'zebra-line' }, slug: 'zebra-line',
  }, null)
  const [home] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
  homeId = home!.id
  await saveDataRowDraft(harness.db, MAIN_SCOPE, homeId, {
    cells: { ...home!.cells, access: { level: 'members', onDeny: 'hide' } },
    slug: home!.slug,
  })

  const manifest = {
    ...parsePluginManifest({
      id: MOVER, name: 'Mover', version: '1.0.0', apiVersion: 1, permissions: PERMISSIONS,
      contentAccess: [
        { table: 'posts', modes: ['write'] },
        { table: 'pages', modes: ['write'] },
        { table: 'inbox', modes: ['read', 'write'] },
      ],
    }),
    grantedPermissions: PERMISSIONS,
  } as PluginManifest
  await writeFile(join(dir, 'index.js'), SOURCE)
  await installPlugin(harness.db, manifest)
  setPluginHostContext({ db: harness.db, uploadsDir: dir })
  setApiCallDispatcher(dispatchApiCall)
  const loaded = await loadPluginInWorker({ manifest, entryFileUrl: join(dir, 'index.js'), assetRootPath: dir, settings: {} })
  if (!loaded.ok) throw new Error(loaded.error ?? 'load failed')
  await runLifecycleInWorker(MOVER, 'activate')
})

afterAll(async () => {
  await resetPluginWorker()
  hostPlugins.delete(MOVER)
  await harness.cleanup()
  await rm(dir, { recursive: true, force: true })
})

describe('moving an entry to another table', () => {
  it('is not something a plugin can do', async () => {
    // A move changes where an entry is live and which access rule covers it.
    expect((await ask('/can-move')).ok).toBe('undefined')
    // And the host has no such call either, whatever the sandbox is told.
    const targets = await import('../../../server/plugins/protocol/targets')
    expect(Object.keys(targets.TARGET_PERMISSIONS).filter((target) => /move/i.test(target))).toEqual([])
    expect((await getDataRow(harness.db, MAIN_SCOPE, 'post_private'))!.tableId).toBe('posts')
    expect((await getDataRow(harness.db, MAIN_SCOPE, homeId))!.cells.access).toEqual({ level: 'members', onDeny: 'hide' })
  })
})

describe('finding out what a table holds', () => {
  it('search returns entries only of tables the plugin may read', async () => {
    const found = (await ask('/search', { q: 'Zebra' })).ok as Array<{ tableSlug: string }>
    expect(found.map((hit) => hit.tableSlug)).not.toContain('posts')
    expect(found.map((hit) => hit.tableSlug)).not.toContain('ledger')
  })

  it('tables.list names only tables the plugin may read', async () => {
    const listed = (await ask('/tables')).ok as Array<{ slug: string }>
    expect(listed.map((table) => table.slug)).toEqual(['inbox'])
  })

  it('tables.get answers the same for a table that is missing and one it may not read', async () => {
    const forbidden = await ask('/table', { slug: 'ledger' })
    const missing = await ask('/table', { slug: 'no-such-table' })
    expect(forbidden).toEqual(missing)
    expect(await ask('/table', { slug: 'posts' })).toEqual(missing)
    expect(((await ask('/table', { slug: 'inbox' })).ok as { slug: string }).slug).toBe('inbox')
  })
})

describe('what a refusal gives away', () => {
  it('a taken slug is reported as a taken slug, not as a database error', async () => {
    const clash = await ask('/create', { table: 'posts', slug: 'zebra-forecast' })
    expect(clash.refused).toBe('The slug "zebra-forecast" is already used in table "posts".')
  })

  it('a tree call checks access before saying whether the entry or field exists', async () => {
    // `ledger`: no access at all. An entry there, a missing entry and a
    // missing field all answer alike.
    const answers = await Promise.all([
      ask('/tree-read', { id: 'ledger_1', field: 'body' }),
      ask('/tree-read', { id: 'no-such-entry', field: 'body' }),
      ask('/tree-read', { id: 'ledger_1', field: 'no-such-field' }),
      ask('/tree-replace', { id: 'ledger_1', field: 'body' }),
      ask('/tree-replace', { id: 'no-such-entry', field: 'body' }),
    ])
    const shape = (answer: Answer) =>
      answer.refused?.replace(/"(ledger_1|no-such-entry)"/, '"<entry>"').replace(/"(body|no-such-field)"/, '"<field>"')
    expect(new Set(answers.map(shape)).size).toBe(1)
    expect(answers[0]!.refused).toContain('not found, or not within')

    // `pages`: write without read. Changing a tree node by node needs both,
    // and reading it is refused in the same words as for a table with no access.
    const words = (id: string) => answers[0]!.refused!.replace('ledger_1', id)
    expect((await ask('/tree-mutate', { id: homeId, field: 'body' })).refused).toBe(words(homeId))
    expect((await ask('/tree-read', { id: homeId, field: 'body' })).refused).toBe(words(homeId))
    // Replacing the whole tree needs write only, which it has.
    expect((await ask('/tree-replace', { id: homeId, field: 'body' })).refused).toBeUndefined()
  })

  it('a write answered without cells does not name the author either', async () => {
    const updated = (await ask('/update', {
      table: 'posts', id: 'post_private', cells: JSON.stringify({ title: 'Retitled' }),
    })).ok as Record<string, unknown>
    expect(updated.cells).toEqual({})
    // (A null crosses the sandbox bridge as an absent value.)
    expect(updated.authorUserId ?? null).toBeNull()
  })
})
