/**
 * Plugin loop sources as the editor reaches them.
 *
 * A plugin registers its sources in the server process. The editor learns of
 * them from `GET /admin/api/cms/loop-sources` and draws the canvas from
 * `POST /admin/api/cms/loop-sources/preview`, which runs the plugin's own
 * `preview()` in its sandbox. These tests install a real plugin and go
 * through the real worker.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOP_PREVIEW_BUSY_CODE, LOOP_PREVIEW_MAX_ITEMS, type RemoteLoopSource } from '@core/loops'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { clearPluginCrashCounter, recordCrashAndDecide } from '../../../server/plugins/host/crashRecovery'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { unloadPlugin } from '../../../server/plugins/runtime'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const PLUGIN_ID = 'acme.shop'
const PERMISSIONS = ['loops.register', 'members.read', 'cms.routes']

// Every fetch throws: a preview that reached `fetch` would fail these tests.
const PLUGIN_SOURCE = `
  export async function activate(api) {
    api.cms.routes.get('/ping', 'plugins.read', () => ({ pong: true }))
    const fetch = async () => { throw new Error('fetch must not run for a preview') }
    const fields = [{ id: 'title', label: 'Title' }, { id: 'told', label: 'Told' }]
    const base = { orderByOptions: [{ id: 'name', label: 'Name' }], fields, fetch }
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.offers', label: 'Offers', description: 'Plans on sale',
      filterSchema: { currency: { type: 'text', label: 'Currency' } },
      preview: (ctx) => Array.from({ length: 40 }, (_, i) => ({
        id: 'sample-' + i,
        fields: { title: 'Sample ' + (ctx.filters.currency || 'any') + ' ' + i, told: Object.keys(ctx).sort().join(',') },
      })),
    })
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.account', label: 'My subscription', filterSchema: {}, perVisitor: true,
      preview: (ctx) => [{ id: 'sample', fields: { title: 'Sample member', told: JSON.stringify(ctx) } }],
    })
    await api.cms.loops.registerSource({ ...base, id: 'acme.shop.bare', label: 'Bare', filterSchema: {} })
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.broken', label: 'Broken', filterSchema: {},
      preview: () => { throw new Error('no samples today') },
    })
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.shapeless', label: 'Shapeless', filterSchema: {},
      preview: () => [{ title: 'no id, no fields' }],
    })
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.huge', label: 'Huge', filterSchema: {},
      // 100,000 characters, 300,000 bytes: over the cap only when bytes are counted.
      preview: () => [{ id: '1', fields: { title: '€'.repeat(100 * 1000) } }],
    })
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.deep', label: 'Deep', filterSchema: {},
      preview: () => {
        let value = 'leaf'
        for (let i = 0; i < 20; i++) value = { inner: value }
        return [{ id: '1', fields: { title: value } }]
      },
    })
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.stuck', label: 'Stuck', filterSchema: {},
      preview: () => { for (;;) {} },
    })
    let runs = 0
    await api.cms.loops.registerSource({
      ...base, id: 'acme.shop.counted', label: 'Counted', filterSchema: {},
      preview: () => [{ id: '1', fields: { title: 'run ' + (++runs) } }],
    })
    // Registered a second time: still one source.
    await api.cms.loops.registerSource({ ...base, id: 'acme.shop.bare', label: 'Bare', filterSchema: {} })
  }
`

const SOURCE_IDS = [
  'acme.shop.account', 'acme.shop.bare', 'acme.shop.broken', 'acme.shop.counted', 'acme.shop.deep',
  'acme.shop.huge', 'acme.shop.offers', 'acme.shop.shapeless', 'acme.shop.stuck',
]

describe('plugin loop sources for the editor', () => {
  let h: CapabilityTestHarness
  let owner: string
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'loop-sources-editor-'))
    h = await createCapabilityTestHarness({ uploadsDir })
    owner = await h.setupOwner()
    await install()
  })

  afterEach(async () => {
    // The loop registry is one per process: unload the plugin so its sources
    // and its worker do not outlive this test into whichever file runs next.
    await unloadPlugin(PLUGIN_ID)
    await h.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(): Promise<void> {
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify({
        id: PLUGIN_ID, name: 'Acme Shop', version: '1.0.0', apiVersion: 1, permissions: PERMISSIONS,
        entrypoints: { server: 'server/index.js' }, resources: [], adminPages: [],
      })),
      'server/index.js': strToU8(PLUGIN_SOURCE),
    })
    const formData = new FormData()
    formData.set('file', new File([zipped], 'plugin.zip', { type: 'application/zip' }))
    formData.set('grantedPermissions', JSON.stringify(PERMISSIONS))
    // The test DOM cannot carry a multipart body through `new Request`, so the form is handed over directly.
    const req = {
      url: 'http://localhost/admin/api/cms/plugins/package',
      method: 'POST',
      headers: { get: (name: string) => (name.toLowerCase() === 'cookie' ? owner : null) },
      formData: async () => formData,
    } as unknown as Request
    expect((await handleCmsRequest(req, h.db, { uploadsDir })).status).toBe(201)
  }

  async function list(cookie: string | undefined = owner): Promise<Response> {
    return h.cms('/admin/api/cms/loop-sources', { cookie })
  }

  function preview(json: unknown, cookie: string | undefined = owner): Promise<Response> {
    return h.cms('/admin/api/cms/loop-sources/preview', { method: 'POST', cookie, json })
  }

  it('lists what the plugin registered, with the plugin as the provider', async () => {
    const res = await list()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const { sources } = (await res.json()) as { sources: RemoteLoopSource[] }
    // `bare` is registered twice by the plugin and listed once.
    expect(sources.map((source) => source.id).sort()).toEqual(SOURCE_IDS)
    const offers = sources.find((source) => source.id === 'acme.shop.offers')!
    expect(offers).toEqual({
      id: 'acme.shop.offers',
      label: 'Offers',
      description: 'Plans on sale',
      filterSchema: { currency: { type: 'text', label: 'Currency' } },
      orderByOptions: [{ id: 'name', label: 'Name' }],
      fields: [{ id: 'title', label: 'Title' }, { id: 'told', label: 'Told' }],
      provider: { pluginId: PLUGIN_ID, pluginName: 'Acme Shop' },
    })
    expect(sources.find((source) => source.id === 'acme.shop.account')!.perVisitor).toBe(true)
  })

  it('previews through the plugin\'s preview(), with the loop\'s filters and never more than asked', async () => {
    const res = await preview({ sourceId: 'acme.shop.offers', filters: { currency: 'eur' }, limit: 3 })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const { items } = (await res.json()) as { items: Array<{ id: string; fields: Record<string, string> }> }
    expect(items.map((item) => item.fields.title)).toEqual(['Sample eur 0', 'Sample eur 1', 'Sample eur 2'])
    // The plugin is handed the filters and a limit, and nothing else.
    expect(items[0]!.fields.told).toBe('filters,limit')
  })

  it('tells a per-visitor source nothing about a visitor or a member', async () => {
    const res = await preview({ sourceId: 'acme.shop.account', filters: {}, limit: 6 })
    const { items } = (await res.json()) as { items: Array<{ fields: { told: string } }> }
    expect(JSON.parse(items[0]!.fields.told)).toEqual({ filters: {}, limit: 6 })
  })

  it('answers an empty list for a source without a preview', async () => {
    const res = await preview({ sourceId: 'acme.shop.bare', filters: {}, limit: 6 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [] })
  })

  it('reports a preview that throws, returns the wrong shape or is too large', async () => {
    const broken = await preview({ sourceId: 'acme.shop.broken', filters: {}, limit: 6 })
    expect(broken.status).toBe(502)
    // What the plugin threw is for the server log, not for whoever has the page open.
    const reason = ((await broken.json()) as { error: string }).error
    expect(reason).toContain('preview() failed')
    expect(reason).not.toContain('no samples today')

    const shapeless = await preview({ sourceId: 'acme.shop.shapeless', filters: {}, limit: 6 })
    expect(shapeless.status).toBe(502)
    expect(((await shapeless.json()) as { error: string }).error).toContain('{ id: string, fields')

    const huge = await preview({ sourceId: 'acme.shop.huge', filters: {}, limit: 6 })
    expect(huge.status).toBe(502)
    expect(((await huge.json()) as { error: string }).error).toContain('more data')

    const deep = await preview({ sourceId: 'acme.shop.deep', filters: {}, limit: 6 })
    expect(deep.status).toBe(502)
    expect(((await deep.json()) as { error: string }).error).toContain('nested too deeply')
  })

  it('cuts a preview that never returns short, and the plugin carries on', async () => {
    const started = Date.now()
    const stuck = await preview({ sourceId: 'acme.shop.stuck', filters: {}, limit: 6 })
    expect(stuck.status).toBe(502)
    expect(Date.now() - started).toBeLessThan(4_000)

    // Not a worker fault: nothing was recorded against the plugin, and it still answers.
    const { rows } = await h.db<{ n: number }>`select count(*) as n from plugin_crash_events`
    expect(Number(rows[0]!.n)).toBe(0)
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: 3 })).status).toBe(200)
    expect(((await (await list()).json()) as { sources: unknown[] }).sources).toHaveLength(SOURCE_IDS.length)
  })

  it('runs identical previews once, and limits how many one user may start for a plugin', async () => {
    const titles = async (res: Response) =>
      ((await res.json()) as { items: Array<{ fields: { title: string } }> }).items.map((item) => item.fields.title)
    const ask = (filters: Record<string, unknown>, cookie?: string) =>
      preview({ sourceId: 'acme.shop.counted', filters, limit: 1 }, cookie)

    const [a, b] = await Promise.all([ask({}), ask({})])
    expect(await titles(a)).toEqual(['run 1'])
    expect(await titles(b)).toEqual(['run 1'])

    // 29 more distinct previews bring this user to the limit for this plugin.
    for (let i = 0; i < 29; i++) expect((await ask({ i })).status).toBe(200)
    const refused = await ask({ i: 'one too many' })
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await refused.json()) as { code: string }).code).toBe(LOOP_PREVIEW_BUSY_CODE)
    // The limit is the plugin's, not one source's.
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: 1 })).status).toBe(429)

    // Another user is counted on their own.
    const editor = await h.createRoleUser({ name: 'Second editor', slug: 'second-editor', capabilities: ['site.read'] })
    expect((await ask({ other: true }, editor.cookie)).status).toBe(200)
  })

  it('hands a plugin one preview at a time and turns the rest away once the line is full', async () => {
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => preview({ sourceId: 'acme.shop.counted', filters: { i }, limit: 1 })),
    )
    // One running and three waiting are answered; the other four never reach the plugin.
    expect(answers.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 429, 429, 429, 429])
    const ran = await Promise.all(
      answers.filter((res) => res.status === 200).map(async (res) =>
        ((await res.json()) as { items: Array<{ fields: { title: string } }> }).items[0]!.fields.title),
    )
    expect(ran.sort()).toEqual(['run 1', 'run 2', 'run 3', 'run 4'])
  })

  it('cannot be used to take the plugin down with previews that never return', async () => {
    const editors = await Promise.all(
      [0, 1].map((n) => h.createRoleUser({ name: `Editor ${n}`, slug: `editor-${n}`, capabilities: ['site.read'] })),
    )
    // Thirty distinct stuck previews from one editor and eight from another, all at once.
    const stuck = (i: number, cookie: string) => preview({ sourceId: 'acme.shop.stuck', filters: { i }, limit: 1 }, cookie)
    const answers = await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => stuck(i, editors[0]!.cookie)),
      ...Array.from({ length: 8 }, (_, i) => stuck(100 + i, editors[1]!.cookie)),
    ])
    const statuses = answers.map((res) => res.status)
    // Four reached the plugin and were cut off after a second each; the rest were turned away.
    expect(statuses.filter((status) => status === 502)).toHaveLength(4)
    expect(statuses.filter((status) => status === 429)).toHaveLength(34)

    // The plugin is still there: registered, its sources listed, its own route answering.
    expect(hostPlugins.has(PLUGIN_ID)).toBe(true)
    expect(((await (await list()).json()) as { sources: unknown[] }).sources).toHaveLength(SOURCE_IDS.length)
    const ping = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}/runtime/ping`, { cookie: owner })
    expect(ping.status).toBe(200)
    expect(await ping.json()).toEqual({ pong: true })

    // And nothing was held against it: no crash event, and the crash window is empty
    // (recording one now makes it the first).
    const { rows } = await h.db<{ n: number }>`select count(*) as n from plugin_crash_events`
    expect(Number(rows[0]!.n)).toBe(0)
    expect(recordCrashAndDecide(PLUGIN_ID).recentCrashCount).toBe(1)
    clearPluginCrashCounter(PLUGIN_ID)
  }, 20_000)

  it('refuses a request it cannot read, and a source no plugin provides', async () => {
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: LOOP_PREVIEW_MAX_ITEMS + 1 })).status).toBe(400)
    expect((await preview({ sourceId: 'acme.shop.offers', limit: 3 })).status).toBe(400)
    expect((await preview({ sourceId: 'data.rows', filters: {}, limit: 3 })).status).toBe(404)
    expect((await preview({ sourceId: 'acme.shop.nope', filters: {}, limit: 3 })).status).toBe(404)
  })

  it('needs a signed-in user who can read the site, and no rights over plugins', async () => {
    expect((await list('')).status).toBe(401)
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: 3 }, '')).status).toBe(401)

    const editor = await h.createRoleUser({ name: 'Page editor', slug: 'page-editor', capabilities: ['site.read'] })
    expect((await list(editor.cookie)).status).toBe(200)
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: 3 }, editor.cookie)).status).toBe(200)

    const outsider = await h.createRoleUser({ name: 'Mail only', slug: 'mail-only', capabilities: ['dashboard.read'] })
    expect((await list(outsider.cookie)).status).toBe(403)
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: 3 }, outsider.cookie)).status).toBe(403)
  })

  it('drops the sources when the plugin is disabled, and brings them back when it is enabled', async () => {
    const disabled = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'PATCH', cookie: owner, json: { enabled: false } })
    expect(disabled.status).toBe(200)
    expect(await (await list()).json()).toEqual({ sources: [] })
    expect((await preview({ sourceId: 'acme.shop.offers', filters: {}, limit: 3 })).status).toBe(404)

    const enabled = await h.cms(`/admin/api/cms/plugins/${PLUGIN_ID}`, { method: 'PATCH', cookie: owner, json: { enabled: true } })
    expect(enabled.status).toBe(200)
    const { sources } = (await (await list()).json()) as { sources: RemoteLoopSource[] }
    expect(sources).toHaveLength(SOURCE_IDS.length)
  })
})
