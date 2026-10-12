import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { setPluginRedirect } from '../../../server/repositories/pluginRedirects'
import { tryServePluginRedirect } from '../../../server/publish/publicRoutes'
import type { ServerRuntime } from '../../../server/serverRuntime'
import { bumpPublishVersion } from '../../../server/publish/publishState'
import { prepareInactiveSlot, swapSlot, writeArtefact } from '../../../server/publish/staticArtefact'
import { renderNotFoundResponse } from '../../../server/publish/publicRouter'
import { persistSitePublish } from '../../../server/repositories/publish'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { persistDataRowPublish } from '../../../server/repositories/data/publish'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { makePage, makeSite } from '../publisher/helpers'
import type { Page } from '@core/page-tree'
import { createSite } from '../../../server/repositories/setup'
import { handleServerRequest } from '../../../server/router'
import type { DbClient, DbResult } from '../../../server/db'
import { deletePlugin } from '../../../server/repositories/plugins'
import { listPluginRedirects } from '../../../server/repositories/pluginRedirects'

describe('plugin redirect public route', () => {
  let testDb: TestDb
  let uploadsDir: string
  let runtime: ServerRuntime

  beforeEach(async () => {
    testDb = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-redirect-'))
    runtime = { db: testDb.db, uploadsDir }
    bumpPublishVersion()
    await testDb.db`
      insert into installed_plugins (id, name, version, manifest_json)
      values (${'plugin.a'}, ${'Redirect test'}, ${'1.0.0'}, ${JSON.stringify({ id: 'plugin.a' })})
    `
    await createSite(testDb.db, 'Redirect test', {})
    await testDb.db`
      insert into users (id, email, email_normalized, display_name, password_hash, role_id)
      values (${'owner'}, ${'redirect@example.test'}, ${'redirect@example.test'}, ${'Test owner'}, ${'unused'}, ${'owner'})
    `
  })

  afterEach(async () => {
    await testDb.cleanup()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  async function request(path: string, method = 'GET'): Promise<Response | null> {
    const url = new URL(path, 'http://localhost')
    return tryServePluginRedirect(new Request(url, { method }), runtime, url, url.pathname)
  }

  async function publishPages(pages: Page[]): Promise<void> {
    for (const page of pages) {
      await createDataRow(testDb.db, MAIN_SCOPE, {
        id: page.id, tableId: 'pages', slug: page.slug,
        cells: { title: page.title, body: { nodes: page.nodes, rootNodeId: page.rootNodeId } },
      })
    }
    await persistSitePublish(testDb.db, {
      siteSnapshotId: crypto.randomUUID(), site: makeSite({ pages }), serializedImportmap: null,
      publishedByUserId: 'owner',
      pages: pages.map((page) => ({
        pageId: page.id, title: page.title, slug: page.slug, versionId: crypto.randomUUID(),
        versionNumber: 1, runtimeAssets: null, runtimeFiles: [],
      })),
    })
    bumpPublishVersion()
  }

  it('AC-1: an unmatched GET receives the stored permanent redirect', async () => {
    await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: '/new', status: 301 })
    const response = await request('/old')
    expect(response?.status).toBe(301)
    expect(response?.headers.get('location')).toBe('/new')
    expect(await response!.text()).toBe('')
    expect(await request('/missing')).toBeNull()
  })

  it('AC-7/AC-8: rejects a raw Unicode source and matches its percent-encoded pathname on GET', async () => {
    await expect(setPluginRedirect(testDb.db, 'plugin.a', {
      fromPath: '/café', toLocation: '/new', status: 301,
    })).rejects.toMatchObject({ name: 'PluginRedirectValidationError', field: 'fromPath', message: expect.stringContaining('percent-encode') })
    const rule = await setPluginRedirect(testDb.db, 'plugin.a', {
      fromPath: '/caf%C3%A9', toLocation: '/new', status: 301,
    })
    expect(rule.fromPath).toBe('/caf%C3%A9')
    const response = await handleServerRequest(new Request('http://localhost/caf%C3%A9'), runtime)
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/new')
  })

  it('AC-1: valid Unicode destinations are encoded for the Location header without double-encoding escapes', async () => {
    await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: '/你好?own=%20#café', status: 301 })
    const response = await request('/old')
    expect(response?.status).toBe(301)
    expect(response?.headers.get('location')).toBe('/%E4%BD%A0%E5%A5%BD?own=%20#caf%C3%A9')
  })

  it('AC-2: preserves the request query unless the target already contains a query', async () => {
    for (const [toLocation, expected] of [
      ['/new', '/new?utm=x&v=%2F'],
      ['/new?own=y', '/new?own=y'],
      ['/new?', '/new?'],
      ['/new#section', '/new?utm=x&v=%2F#section'],
      ['https://example.com/new', 'https://example.com/new?utm=x&v=%2F'],
    ]) {
      await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: toLocation!, status: 301 })
      expect((await request('/old?utm=x&v=%2F'))?.headers.get('location')).toBe(expected)
    }
  })

  it('AC-4: 410 reuses the live or baked 404 body and headers, else returns plain text', async () => {
    await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/gone', toLocation: null, status: 410 })
    const plain = await request('/gone')
    expect(plain?.status).toBe(410)
    expect(plain?.headers.get('location')).toBeNull()
    expect(plain?.headers.get('content-type')).toContain('text/plain')
    expect(await plain!.text()).toBe('Gone')
    const notFound = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: { text: 'This page is missing', tag: 'h1' } },
    })
    notFound.id = 'not-found'
    notFound.slug = 'not-found'
    notFound.template = { enabled: true, target: { kind: 'notFound' }, priority: 0 }
    await publishPages([notFound])
    const url = new URL('http://localhost/gone')
    const designed = await renderNotFoundResponse(testDb.db, url, uploadsDir)
    const live = await request('/gone')
    expect(live?.status).toBe(410)
    expect([...live!.headers]).toEqual([...designed!.headers])
    const liveBody = await live!.text()
    expect(liveBody).toContain('This page is missing')
    expect(liveBody).toBe(await designed!.text())
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/404', '<html>Baked missing page</html>')
    await swapSlot(uploadsDir, slot)
    const baked = await request('/gone')
    expect(baked?.status).toBe(410)
    expect(baked?.headers.get('content-type')).toContain('text/html')
    expect(await baked!.text()).toBe('<html>Baked missing page</html>')
  })

  it('AC-5: preserves each redirect status and prevents caching of 302 and 307', async () => {
    for (const status of [301, 302, 307, 308] as const) {
      await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: '/new', status })
      const response = await request('/old')
      expect(response?.status).toBe(status)
      expect(response?.headers.get('location')).toBe('/new')
      expect(response?.headers.get('cache-control')).toBe(status === 302 || status === 307 ? 'no-store' : null)
    }
  })

  it('AC-6: HEAD matches GET status and location without a body; write methods fall through', async () => {
    for (const status of [301, 302, 307, 308, 410] as const) {
      await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: status === 410 ? null : '/new', status })
      const get = await request('/old?utm=x')
      const head = await request('/old?utm=x', 'HEAD')
      expect(head?.status).toBe(get?.status)
      expect(head?.headers.get('location')).toBe(get?.headers.get('location'))
      expect(head?.headers.get('content-type')).toBe(get?.headers.get('content-type'))
      expect(await head!.text()).toBe('')
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect(await request('/old', method)).toBeNull()
    }
  })

  it('AC-6: the dispatcher gives HEAD the same redirect status and headers as GET', async () => {
    for (const status of [301, 302, 307, 308, 410] as const) {
      await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: status === 410 ? null : '/new', status })
      const get = await handleServerRequest(new Request('http://localhost/old?utm=x'), runtime)
      const head = await handleServerRequest(new Request('http://localhost/old?utm=x', { method: 'HEAD' }), runtime)
      expect(head.status).toBe(status)
      expect(head.status).toBe(get.status)
      expect([...head.headers]).toEqual([...get.headers])
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await handleServerRequest(new Request('http://localhost/old', { method }), runtime)
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
    }
  })

  it('AC-3: the dispatcher serves live pages, rows, artefacts and rename redirects before plugin rules', async () => {
    const db = testDb.db
    const about = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: { text: 'Published about', tag: 'h1' } },
    })
    about.id = 'about'
    about.slug = 'about'
    const entry = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: { text: '{currentEntry.title}', tag: 'h1' } },
    })
    entry.id = 'entry'
    entry.slug = 'entry'
    entry.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 }
    await publishPages([about, entry])
    await db`update data_tables set route_base = ${'/posts'} where id = ${'posts'}`
    const post = await createDataRow(db, MAIN_SCOPE, { tableId: 'posts', slug: 'live', cells: { title: 'Published row' } })
    await persistDataRowPublish(db, post.id, 'owner')
    const renamed = await createDataRow(db, MAIN_SCOPE, { tableId: 'posts', slug: 'old-name', cells: { title: 'Renamed row' } })
    await persistDataRowPublish(db, renamed.id, 'owner')
    await saveDataRowDraft(db, MAIN_SCOPE, renamed.id, { slug: 'new-name', cells: renamed.cells })
    await persistDataRowPublish(db, renamed.id, 'owner')
    bumpPublishVersion()
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/baked', '<html>Baked live page</html>')
    await swapSlot(uploadsDir, slot)
    for (const fromPath of ['/about', '/posts/live', '/baked', '/posts/old-name', '/orphan']) {
      await setPluginRedirect(db, 'plugin.a', { fromPath, toLocation: '/plugin-target', status: 302 })
    }
    let redirectQueries = 0
    const trackingDb: DbClient = Object.assign(
      async <Row = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<DbResult<Row>> => {
        if (strings.join(' ').includes('from plugin_redirects')) redirectQueries += 1
        return db<Row>(strings, ...values)
      },
      { unsafe: db.unsafe, transaction: db.transaction, close: db.close, dialect: db.dialect },
    )
    const trackingRuntime = { ...runtime, db: trackingDb }
    const unmatched = await handleServerRequest(new Request('http://localhost/orphan'), trackingRuntime)
    expect(unmatched.status).toBe(302)
    expect(unmatched.headers.get('location')).toBe('/plugin-target')
    expect(redirectQueries).toBe(1)
    for (const [path, content] of [['/about', 'Published about'], ['/posts/live', 'Published row'], ['/baked', 'Baked live page']]) {
      const response = await handleServerRequest(new Request(`http://localhost${path}`), trackingRuntime)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(content!)
    }
    const rename = await handleServerRequest(new Request('http://localhost/posts/old-name'), trackingRuntime)
    expect(rename.status).toBe(301)
    expect(rename.headers.get('location')).toBe('/posts/new-name')
    expect(redirectQueries).toBe(1)
    const missing = await handleServerRequest(new Request('http://localhost/missing'), trackingRuntime)
    expect(missing.status).toBe(404)
    expect(redirectQueries).toBe(2)
  })

  it('AC-11: uninstall cascades all owned rules and the old URL falls through to the site 404', async () => {
    await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/old', toLocation: '/new', status: 301 })
    await setPluginRedirect(testDb.db, 'plugin.a', { fromPath: '/another', toLocation: null, status: 410 })
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/404', '<html>Site missing page</html>')
    await swapSlot(uploadsDir, slot)
    expect((await handleServerRequest(new Request('http://localhost/old'), runtime)).status).toBe(301)
    expect(await deletePlugin(testDb.db, 'plugin.a')).toBe(true)
    expect(await listPluginRedirects(testDb.db, 'plugin.a')).toEqual([])
    const after = await handleServerRequest(new Request('http://localhost/old'), runtime)
    expect(after.status).toBe(404)
    expect(await after.text()).toBe('<html>Site missing page</html>')
  })

  it('AC-15: the public route-order documentation places plugin rules immediately before the 404 handler', async () => {
    const doc = await readFile(new URL('../../../docs/server.md', import.meta.url), 'utf8')
    const table = doc.split('const routes: readonly RouteHandler[] = [')[1]!.split(']')[0]!
    const handlers = [...table.matchAll(/^ {2}(try\w+),/gm)].map((match) => match[1])
    expect(handlers.slice(-3)).toEqual(['trySetupRedirect', 'tryServePluginRedirect', 'tryServeNotFoundPage'])
    expect(table).toContain('301/302/307/308/410')
    const publisherDoc = await readFile(new URL('../../../docs/features/publisher.md', import.meta.url), 'utf8')
    const fallthrough = publisherDoc.split('router falls through:')[1]!.split('→ renderNotFoundResponse')[0]!
    const publisherHandlers = [...fallthrough.matchAll(/\btry\w+/g)].map((match) => match[0])
    expect(publisherHandlers).toEqual(['trySetupRedirect', 'tryServePluginRedirect', 'tryServeNotFoundPage'])
  })
})
