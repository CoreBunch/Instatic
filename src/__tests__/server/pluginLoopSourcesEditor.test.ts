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
import { LOOP_PREVIEW_MAX_ITEMS, type RemoteLoopSource } from '@core/loops'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { unloadPlugin } from '../../../server/plugins/runtime'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const PLUGIN_ID = 'acme.shop'
const PERMISSIONS = ['loops.register', 'members.read']

// Every fetch throws: a preview that reached `fetch` would fail these tests.
const PLUGIN_SOURCE = `
  export async function activate(api) {
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
      preview: () => [{ id: '1', fields: { title: 'x'.repeat(300 * 1024) } }],
    })
  }
`

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
    expect(sources.map((source) => source.id).sort()).toEqual([
      'acme.shop.account', 'acme.shop.bare', 'acme.shop.broken',
      'acme.shop.huge', 'acme.shop.offers', 'acme.shop.shapeless',
    ])
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
    expect(((await broken.json()) as { error: string }).error).toContain('no samples today')

    const shapeless = await preview({ sourceId: 'acme.shop.shapeless', filters: {}, limit: 6 })
    expect(shapeless.status).toBe(502)
    expect(((await shapeless.json()) as { error: string }).error).toContain('{ id: string, fields')

    const huge = await preview({ sourceId: 'acme.shop.huge', filters: {}, limit: 6 })
    expect(huge.status).toBe(502)
    expect(((await huge.json()) as { error: string }).error).toContain('more data')
  })

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
    expect(sources).toHaveLength(6)
  })
})
