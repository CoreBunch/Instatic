/**
 * `api.cms.redirects` end to end — real plugin package, real sandbox, real
 * public dispatcher.
 *
 * Each plugin is a real `.zip` installed through the cms install endpoint,
 * so its server module runs in the real plugin worker + QuickJS sandbox and
 * its `api.cms.redirects.*` calls go through the real host dispatcher into
 * the real repository on a `createTestDb()` database. The plugin exposes its
 * calls as public runtime routes, so the test drives them over HTTP and reads
 * the sandbox's results back as JSON. Public GETs go through
 * `handleServerRequest`, the same dispatcher `Bun.serve` uses.
 *
 * Covers AC-1 (a stored rule redirects), AC-3 (a published page wins),
 * AC-9 (no grant = sandbox rejection, no row), AC-11 (uninstall removes the
 * plugin's rules).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { handleServerRequest } from '../../../server/router'
import type { ServerRuntime } from '../../../server/serverRuntime'
import { bumpPublishVersion } from '../../../server/publish/publishState'
import { persistSitePublish } from '../../../server/repositories/publish'
import { createDataRow } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { makePage, makeSite } from '../publisher/helpers'

const GRANTED_ID = 'acme.redirects'
const UNGRANTED_ID = 'acme.noredirects'

/**
 * Plugin server module. `/set?from=…&to=…&status=…` calls
 * `api.cms.redirects.set` inside the sandbox; `/list` calls `list()`. A
 * sandbox rejection comes back as `{ error }` so the test can read it.
 */
const SERVER_ENTRYPOINT = `
  export function activate(api) {
    api.cms.routes.public.get('/set', async ({ req }) => {
      const q = new URL(req.url).searchParams
      try {
        const rule = await api.cms.redirects.set({
          from: q.get('from'),
          to: q.get('to'),
          status: Number(q.get('status')),
        })
        return { rule }
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) }
      }
    })
    api.cms.routes.public.get('/list', async () => ({ rules: await api.cms.redirects.list() }))
  }
`

function pluginZip(id: string, permissions: string[]): File {
  const manifest = {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    permissions,
    entrypoints: { server: 'server/index.js' },
    resources: [],
    adminPages: [],
  }
  const zipped = zipSync({
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'server/index.js': strToU8(SERVER_ENTRYPOINT),
  })
  return new File([zipped], 'plugin.zip', { type: 'application/zip' })
}

interface StoredRule { from: string; to: string | null; status: number }

describe('api.cms.redirects end to end', () => {
  let harness: CapabilityTestHarness
  let uploadsDir: string
  let runtime: ServerRuntime
  let cookie: string
  const installed = new Set<string>()

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-redirects-e2e-'))
    harness = await createCapabilityTestHarness({ uploadsDir })
    runtime = { db: harness.db, uploadsDir }
    cookie = await harness.setupOwner()
    bumpPublishVersion()
  })

  afterEach(async () => {
    // Stop any worker a failed test left running (worker state is process-global).
    for (const id of installed) {
      await harness.cms(`/admin/api/cms/plugins/${id}?force=true`, { method: 'DELETE', cookie })
    }
    installed.clear()
    await harness.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function install(id: string, permissions: string[]): Promise<void> {
    const form = new FormData()
    form.set('file', pluginZip(id, permissions))
    form.set('grantedPermissions', JSON.stringify(permissions))
    const res = await harness.cms('/admin/api/cms/plugins/package', { method: 'POST', body: form, cookie })
    expect(res.status).toBe(201)
    installed.add(id)
  }

  async function uninstall(id: string): Promise<void> {
    const res = await harness.cms(`/admin/api/cms/plugins/${id}`, { method: 'DELETE', cookie })
    expect(res.status).toBe(200)
    installed.delete(id)
  }

  /** Calls one of the plugin's public runtime routes and returns its JSON. */
  async function pluginRoute<T>(id: string, route: string): Promise<T> {
    const res = await harness.cms(`/admin/api/cms/plugins/${id}/runtime${route}`)
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }

  function get(path: string): Promise<Response> {
    return handleServerRequest(new Request(`http://localhost${path}`), runtime)
  }

  async function storedRows(): Promise<Array<{ plugin_id: string; from_path: string }>> {
    const { rows } = await harness.db<{ plugin_id: string; from_path: string }>`
      select plugin_id, from_path from plugin_redirects order by plugin_id asc, from_path asc
    `
    return rows
  }

  async function publishPage(slug: string, text: string): Promise<void> {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: { text, tag: 'h1' } },
    })
    page.id = slug
    page.slug = slug
    await createDataRow(harness.db, MAIN_SCOPE, {
      id: page.id, tableId: 'pages', slug: page.slug,
      cells: { title: page.title, body: { nodes: page.nodes, rootNodeId: page.rootNodeId } },
    })
    const { rows } = await harness.db<{ id: string }>`select id from users limit 1`
    await persistSitePublish(harness.db, {
      siteSnapshotId: crypto.randomUUID(), site: makeSite({ pages: [page] }), serializedImportmap: null,
      publishedByUserId: rows[0]!.id,
      pages: [{
        pageId: page.id, title: page.title, slug: page.slug, versionId: crypto.randomUUID(),
        versionNumber: 1, runtimeAssets: null, runtimeFiles: [],
      }],
    })
    bumpPublishVersion()
  }

  const PERMS = ['cms.routes', 'cms.routes.public']

  it('a granted plugin sets a rule from the sandbox, the site redirects, and uninstall removes it', async () => {
    await install(GRANTED_ID, [...PERMS, 'redirects.manage'])

    // Red first: no rule yet, so /old is the site 404.
    expect((await get('/old')).status).toBe(404)

    const set = await pluginRoute<{ rule?: StoredRule; error?: string }>(GRANTED_ID, '/set?from=/old&to=/new&status=301')
    expect(set.error).toBeUndefined()
    expect(set.rule).toMatchObject({ from: '/old', to: '/new', status: 301 })

    const redirected = await get('/old')
    expect(redirected.status).toBe(301)
    expect(redirected.headers.get('location')).toBe('/new')

    const list = await pluginRoute<{ rules: StoredRule[] }>(GRANTED_ID, '/list')
    expect(list.rules).toHaveLength(1)
    expect(list.rules[0]).toMatchObject({ from: '/old', to: '/new', status: 301 })

    await uninstall(GRANTED_ID)
    expect(await storedRows()).toEqual([])
    const after = await get('/old')
    expect(after.status).toBe(404)
    expect(after.headers.get('location')).toBeNull()
  })

  it('a plugin without redirects.manage is rejected inside the sandbox and writes no row', async () => {
    await install(UNGRANTED_ID, PERMS)

    const set = await pluginRoute<{ rule?: StoredRule; error?: string }>(UNGRANTED_ID, '/set?from=/old&to=/new&status=301')
    expect(set.rule).toBeUndefined()
    expect(set.error).toMatch(/requires permission "redirects\.manage"/)
    expect(await storedRows()).toEqual([])
    expect((await get('/old')).status).toBe(404)
  })

  it('a published page at the same path wins over the plugin rule', async () => {
    await install(GRANTED_ID, [...PERMS, 'redirects.manage'])
    const set = await pluginRoute<{ rule?: StoredRule; error?: string }>(GRANTED_ID, '/set?from=/about&to=/elsewhere&status=302')
    expect(set.error).toBeUndefined()

    // Red first: the rule applies while no page exists at /about.
    expect((await get('/about')).status).toBe(302)

    await publishPage('about', 'Published about')
    const page = await get('/about')
    expect(page.status).toBe(200)
    expect(page.headers.get('location')).toBeNull()
    expect(await page.text()).toContain('Published about')
  })
})
