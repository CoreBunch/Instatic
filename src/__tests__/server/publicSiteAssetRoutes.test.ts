import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SiteFile } from '@core/files/schemas'
import type { PublicFileReferences } from '@core/files/references'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { saveDraftSite } from '../../../server/repositories/site'
import { getDraftSiteDocument, getLatestPublishedSiteSnapshot } from '../../../server/repositories/publish'
import { handleServerRequest } from '../../../server/router'
import { getPublishVersion } from '../../../server/publish/publishState'
import { readPublicSiteAsset } from '../../../server/publish/publicSiteAssets'
import { resetPublicFilePreviews } from '../../../server/publish/publicFilePreview'
import { publishDraftSite } from '../../../server/publish/publishSite'
import * as staticIO from '../../../server/publish/staticArtefact'
import { buildPublishedSiteCssBundle } from '../../../server/publish/siteCssBundle'
import { registry } from '@core/module-engine'
import { createDataRow, getDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { pageToCells } from '@core/data/pageFromRow'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'

function asset(content: string, path = 'public/manifest.webmanifest'): SiteFile {
  return { id: 'manifest', path, type: 'asset', blob: { mimeType: 'application/manifest+json', base64: Buffer.from(content).toString('base64') }, createdAt: 1, updatedAt: 1 }
}
let harness: CapabilityTestHarness | null = null
let uploadsDir: string | null = null
afterEach(async () => {
  resetPublicFilePreviews()
  await harness?.cleanup()
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true })
  harness = null
  uploadsDir = null
})

async function setup() {
  uploadsDir = await mkdtemp(join(tmpdir(), 'public-asset-routes-'))
  harness = await createCapabilityTestHarness({ uploadsDir })
  const owner = await harness.setupOwner()
  const site = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
  return { harness, owner, site, runtime: { db: harness.db, uploadsDir } }
}

describe('native public assets through the CMS and visitor routes', () => {
  it('renders an unsaved binary file binding through the ordinary preview publisher', async () => {
    const { harness, owner, site, runtime } = await setup()
    const source = site.pages[0]
    const imageFile: SiteFile = {
      ...asset('image', 'public/logo.png'), id: 'logo',
      blob: { mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP04AAAAASUVORK5CYII=' },
    }
    const root = source.nodes[source.rootNodeId]
    const page = {
      ...source,
      nodes: {
        ...source.nodes,
        [root.id]: { ...root, children: [...root.children, 'logo-node'] },
        'logo-node': { id: 'logo-node', moduleId: 'base.image', props: { src: '{file.logo.url}', alt: 'Preview logo' }, children: [], breakpointOverrides: {}, classIds: [] },
      },
    }
    const response = await harness.cms('/admin/api/cms/runtime/preview', {
      method: 'POST', cookie: owner, json: { pageId: page.id, site: { ...site, pages: [page], files: [...site.files, imageFile] } },
    })
    expect(response.status).toBe(200)
    const { html } = await readJson<{ html: string }>(response)
    expect(html).not.toContain('{file.logo.url}')
    const imageUrl = html.match(/src="(\/admin\/api\/cms\/runtime\/files\/[^"]+)"/)?.[1]
    expect(imageUrl).toBeDefined()
    const image = await harness.cms(imageUrl!, { cookie: owner })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(Buffer.from(imageFile.blob!.base64, 'base64')))
    expect((await handleServerRequest(new Request('http://localhost/logo.png'), runtime)).status).toBe(404)
    expect((await getDraftSiteDocument(harness.db, MAIN_SCOPE))!.files).toEqual(site.files)
  }, 15_000)

  it('does not expose a draft; publishes exact bytes/MIME and keeps published bytes until the next publish', async () => {
    const { harness, owner, site, runtime } = await setup()
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('{"name":"Live"}')] })
    const request = () => new Request('http://localhost/manifest.webmanifest')
    expect((await handleServerRequest(request(), runtime)).status).toBe(404)
    const published = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })
    expect(published.status).toBe(200)
    const live = await handleServerRequest(request(), runtime)
    expect(live.status).toBe(200)
    expect(live.headers.get('content-type')).toBe('application/manifest+json')
    expect(await live.text()).toBe('{"name":"Live"}')
    const etag = live.headers.get('etag')!
    expect((await handleServerRequest(new Request('http://localhost/manifest.webmanifest', { headers: { 'if-none-match': etag } }), runtime)).status).toBe(304)
    const draft = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...draft, files: [...site.files, asset('{"name":"Draft"}')] })
    expect(await (await handleServerRequest(request(), runtime)).text()).toBe('{"name":"Live"}')
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    expect(await (await handleServerRequest(request(), runtime)).text()).toBe('{"name":"Draft"}')
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...draft, files: site.files })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    expect((await handleServerRequest(request(), runtime)).status).toBe(404)
  }, 15_000)

  it('rejects incomplete or reserved assets before changing snapshots, publish version or slot', async () => {
    const { harness, owner, site, runtime } = await setup()
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('{"name":"Live"}')] })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const previous = (await getLatestPublishedSiteSnapshot(harness.db))!
    const version = getPublishVersion()
    for (const invalid of [{ ...asset('pending'), blob: undefined }, asset('hidden', 'public/admin/config')]) {
      await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, invalid] })
      const result = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })
      expect(result.status).toBe(422)
      expect((await getLatestPublishedSiteSnapshot(harness.db))!.site).toEqual(previous.site)
      expect(getPublishVersion()).toBe(version)
      expect(await (await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).text()).toBe('{"name":"Live"}')
    }
  }, 15_000)

  it('rejects missing native page, attribute and SEO file bindings before any publication mutation', async () => {
    const { harness, owner, site, runtime } = await setup()
    const files = [...site.files, asset('published')]
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const previous = (await getLatestPublishedSiteSnapshot(harness.db))!
    const version = getPublishVersion()
    const slot = await staticIO.getActiveSlot(uploadsDir!)
    for (const field of ['node', 'attribute', 'seo']) {
      const page = structuredClone(site.pages[0])
      if (field === 'seo') page.seo = { links: [{ id: 'missing', rel: 'manifest', href: '{file.missing.url}' }] }
      else if (field === 'attribute') page.nodes[page.rootNodeId].props.htmlAttributes = { 'data-asset': '{file.missing.url}' }
      else {
        page.nodes[page.rootNodeId].children.push('missing-file')
        page.nodes['missing-file'] = { id: 'missing-file', moduleId: 'base.image', props: {},
          dynamicBindings: { src: { source: 'file', field: 'missing.url' } }, children: [], breakpointOverrides: {}, classIds: [] }
      }
      await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
      await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files })
      const result = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })
      expect(result.status).toBe(422)
      expect((await readJson<{ error: string }>(result)).error).toContain('file.missing.url')
      expect((await getLatestPublishedSiteSnapshot(harness.db))!.site).toEqual(previous.site)
      expect(getPublishVersion()).toBe(version)
      expect(await staticIO.getActiveSlot(uploadsDir!)).toBe(slot)
      expect(await (await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).text()).toBe('published')
    }
  }, 15_000)

  it.each(['/manifest.webmanifest', '/_instatic/public-assets.json'])(
  'aborts before snapshot/version/slot changes when staging %s fails', async (failedPath) => {
    const { harness, owner, site, runtime } = await setup()
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('published')] })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const previous = (await getLatestPublishedSiteSnapshot(harness.db))!
    const version = getPublishVersion()
    const activeSlot = await staticIO.getActiveSlot(uploadsDir!)
    const draft = { ...site, files: [...site.files, asset('new bytes')] }
    await saveDraftSite(harness.db, MAIN_SCOPE, draft)
    const write = staticIO.writeStaticAsset
    const failure = spyOn(staticIO, 'writeStaticAsset').mockImplementation(async (dir, path, bytes) => {
      if (path === failedPath) throw new Error(`Injected asset staging failure: ${path}`)
      await write(dir, path, bytes)
    })
    try {
      await expect(publishDraftSite(harness.db, 'owner', uploadsDir!)).rejects.toThrow('Injected asset staging failure')
    } finally {
      failure.mockRestore()
    }
    expect((await getLatestPublishedSiteSnapshot(harness.db))!.site).toEqual(previous.site)
    expect(getPublishVersion()).toBe(version)
    expect(await staticIO.getActiveSlot(uploadsDir!)).toBe(activeSlot)
    expect(await (await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).text()).toBe('published')
    expect((await getDraftSiteDocument(harness.db, MAIN_SCOPE))!.files).toEqual(draft.files)
    // The failed bake's next-version memo must not poison a subsequent row
    // publication or retry with different CSS at that same version.
    const cssSite = { ...site, styleRules: { marker: {
      id: 'marker', name: 'marker', kind: 'ambient' as const, selector: 'body', order: 0,
      styles: { color: 'red' }, contextStyles: {}, createdAt: 1, updatedAt: 1,
    } } }
    expect(buildPublishedSiteCssBundle(cssSite, registry, cssSite.pages[0], version + 1).style.content).toContain('red')
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...cssSite, files: draft.files })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    expect(await (await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).text()).toBe('new bytes')
  }, 15_000)

  it('uses only the branch draft behind a live preview grant and stops serving it after revocation', async () => {
    const { harness, owner, site, runtime } = await setup()
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('published')] })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    expect((await harness.cms('/admin/api/cms/branches', { method: 'POST', cookie: owner, json: { name: 'Asset Review' } })).status).toBe(201)
    const scope = { branchId: 'asset-review' }
    const branch = (await getDraftSiteDocument(harness.db, scope))!
    await saveDraftSite(harness.db, scope, { ...branch, files: [...site.files, asset('branch draft')] })
    const { url } = await readJson<{ url: string }>(await harness.cms('/admin/api/cms/branches/asset-review/preview', { method: 'POST', cookie: owner }))
    const entered = await handleServerRequest(new Request(`http://localhost${new URL(url).pathname}`), runtime)
    expect(entered.status).toBe(302)
    const cookie = entered.headers.get('set-cookie')!.split(';')[0]
    const request = () => {
      const req = new Request('http://localhost/manifest.webmanifest')
      req.headers.set('cookie', cookie)
      return req
    }
    const preview = await handleServerRequest(request(), runtime)
    expect(await preview.text()).toBe('branch draft')
    expect(preview.headers.get('cache-control')).toBe('private, no-store')
    expect(preview.headers.get('vary')).toBe('cookie')
    expect(new TextDecoder().decode((await readPublicSiteAsset(uploadsDir!, '/manifest.webmanifest'))!.bytes)).toBe('published')
    await saveDraftSite(harness.db, scope, { ...branch, files: site.files })
    expect((await handleServerRequest(request(), runtime)).status).toBe(404)
    expect((await harness.cms('/admin/api/cms/branches/asset-review/preview', { method: 'DELETE', cookie: owner })).status).toBe(200)
    expect(await (await handleServerRequest(request(), runtime)).text()).toBe('published')
  }, 15_000)

  it('guards incremental route ownership and rebakes published entries from the new prepared template', async () => {
    const { harness, owner, site, runtime } = await setup()
    const template = structuredClone(site.pages[0])
    template.id = 'entry-template'
    template.slug = 'entry-template'
    template.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 10 }
    const root = template.nodes[template.rootNodeId]
    root.children.push('entry-copy')
    template.nodes['entry-copy'] = {
      id: 'entry-copy', moduleId: 'base.text', props: { text: 'Original template: {currentEntry.title}' },
      children: [], breakpointOverrides: {}, classIds: [],
    }
    const withTemplate = { ...site, pages: [...site.pages, template], files: [...site.files, asset('owned asset', 'public/posts/blocked')] }
    await createDataRow(harness.db, MAIN_SCOPE, { id: template.id, tableId: 'pages', slug: template.slug, cells: pageToCells(template) })
    await saveDraftSite(harness.db, MAIN_SCOPE, withTemplate)
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const create = async (slug: string) => {
      const response = await harness.cms('/admin/api/cms/data/tables/posts/rows', {
        method: 'POST', cookie: owner, json: { cells: { title: 'Entry title', slug } },
      })
      expect(response.status).toBe(201)
      return (await readJson<{ row: { id: string } }>(response)).row.id
    }
    const blocked = await create('blocked')
    const version = getPublishVersion()
    expect((await harness.cms(`/admin/api/cms/data/rows/${blocked}/publish`, { method: 'POST', cookie: owner })).status).toBe(422)
    expect((await getDataRow(harness.db, MAIN_SCOPE, blocked))!.status).toBe('draft')
    expect(getPublishVersion()).toBe(version)
    expect(await (await handleServerRequest(new Request('http://localhost/posts/blocked'), runtime)).text()).toBe('owned asset')
    const allowed = await create('allowed')
    expect((await harness.cms(`/admin/api/cms/data/rows/${allowed}/publish`, { method: 'POST', cookie: owner })).status).toBe(200)
    expect(await staticIO.readArtefact(uploadsDir!, '/posts/allowed')).toContain('Original template: Entry title')
    template.nodes['entry-copy'].props.text = 'Prepared new template: {currentEntry.title}'
    await saveDataRowDraft(harness.db, MAIN_SCOPE, template.id, { cells: pageToCells(template), slug: template.slug })
    await saveDraftSite(harness.db, MAIN_SCOPE, withTemplate)
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const baked = await staticIO.readArtefact(uploadsDir!, '/posts/allowed')
    expect(baked).toContain('Prepared new template: Entry title')
    expect(baked).not.toContain('Original template:')
  }, 15_000)

  it('rejects missing entry metadata files before incremental commit and full snapshot activation', async () => {
    const { harness, owner, site, runtime } = await setup()
    const template = structuredClone(site.pages[0])
    template.id = 'metadata-template'
    template.slug = 'metadata-template'
    template.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 10 }
    await createDataRow(harness.db, MAIN_SCOPE, { id: template.id, tableId: 'pages', slug: template.slug, cells: pageToCells(template) })
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('entry asset')] })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const created = await harness.cms('/admin/api/cms/data/tables/posts/rows', {
      method: 'POST', cookie: owner, json: { cells: { title: 'Entry', slug: 'metadata-entry', seoTitle: '{file.missing.path}' } },
    })
    expect(created.status).toBe(201)
    const id = (await readJson<{ row: { id: string } }>(created)).row.id
    const version = getPublishVersion()
    expect((await harness.cms(`/admin/api/cms/data/rows/${id}/publish`, { method: 'POST', cookie: owner })).status).toBe(422)
    expect((await getDataRow(harness.db, MAIN_SCOPE, id))!.status).toBe('draft')
    expect(getPublishVersion()).toBe(version)

    const row = (await getDataRow(harness.db, MAIN_SCOPE, id))!
    await saveDataRowDraft(harness.db, MAIN_SCOPE, id, { cells: { ...row.cells, seoTitle: '{file.manifest.path}' }, slug: row.slug })
    expect((await harness.cms(`/admin/api/cms/data/rows/${id}/publish`, { method: 'POST', cookie: owner })).status).toBe(200)
    const previous = (await getLatestPublishedSiteSnapshot(harness.db))!
    const publishedVersion = getPublishVersion()
    const slot = await staticIO.getActiveSlot(uploadsDir!)
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: site.files })
    const result = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })
    expect(result.status).toBe(422)
    expect((await readJson<{ error: string }>(result)).error).toContain('file.manifest.path')
    expect((await getLatestPublishedSiteSnapshot(harness.db))!.site).toEqual(previous.site)
    expect(getPublishVersion()).toBe(publishedVersion)
    expect(await staticIO.getActiveSlot(uploadsDir!)).toBe(slot)
    expect(await (await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).text()).toBe('entry asset')
  }, 15_000)

  it.each(['pointer', 'commit'])(
  'preserves the previous generation when %s activation fails', async (cause) => {
    const { harness, owner, site, runtime } = await setup()
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('old generation')] })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    const snapshot = (await getLatestPublishedSiteSnapshot(harness.db))!
    const version = getPublishVersion()
    const slot = await staticIO.getActiveSlot(uploadsDir!)
    const accounts = (await harness.db`select id, email, role_id from users order by id`).rows
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('unactivated generation')] })
    const swap = staticIO.swapSlot
    const transaction = harness.db.transaction.bind(harness.db)
    const failure = cause === 'pointer'
      ? spyOn(staticIO, 'swapSlot').mockImplementation(async () => { throw new Error('Injected pointer failure') })
      : spyOn(harness.db, 'transaction').mockImplementation(async (fn) => transaction(async (tx) => {
          await fn(tx)
          throw new Error('Injected commit failure')
        }))
    try {
      await expect(publishDraftSite(harness.db, String(accounts[0].id), uploadsDir!)).rejects.toThrow(`Injected ${cause} failure`)
    } finally {
      failure.mockRestore()
    }
    expect((await getLatestPublishedSiteSnapshot(harness.db))!.site).toEqual(snapshot.site)
    expect(getPublishVersion()).toBe(version)
    expect(await staticIO.getActiveSlot(uploadsDir!)).toBe(slot)
    expect((await harness.db`select id, email, role_id from users order by id`).rows).toEqual(accounts)
    expect(await (await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).text()).toBe('old generation')
    // Keep the original helper referenced to ensure the fault test did not
    // replace the canonical pointer writer for following tests.
    expect(staticIO.swapSlot).toBe(swap)
  }, 15_000)

  it('holds public reads during activation/commit and releases them only with the matching version', async () => {
    const { harness, owner, site, runtime } = await setup()
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('old')] })
    expect((await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })).status).toBe(200)
    await saveDraftSite(harness.db, MAIN_SCOPE, { ...site, files: [...site.files, asset('new')] })
    const version = getPublishVersion()
    let announce!: () => void
    let release!: () => void
    const activated = new Promise<void>((resolve) => { announce = resolve })
    const continueCommit = new Promise<void>((resolve) => { release = resolve })
    const swap = staticIO.swapSlot
    const pause = spyOn(staticIO, 'swapSlot').mockImplementation(async (dir, slot) => {
      await swap(dir, slot)
      announce()
      await continueCommit
    })
    const publishing = harness.cms('/admin/api/cms/publish', { method: 'POST', cookie: owner })
    try {
      await activated
      let readFinished = false
      const reading = handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)
        .then((response) => { readFinished = true; return response })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(readFinished).toBe(false)
      expect(getPublishVersion()).toBe(version)
      release()
      expect((await publishing).status).toBe(200)
      expect(await (await reading).text()).toBe('new')
      expect(getPublishVersion()).toBe(version + 1)
    } finally {
      release()
      pause.mockRestore()
      await publishing
    }
  }, 15_000)

  it('scopes unsaved file capabilities to the authenticated preview owner and never exposes their public path', async () => {
    const { harness, owner, site, runtime } = await setup()
    const posted = [asset('unsaved')]
    expect((await harness.cms('/admin/api/cms/runtime/files', { method: 'POST', json: { files: posted } })).status).toBe(401)
    const response = await harness.cms('/admin/api/cms/runtime/files', { method: 'POST', cookie: owner, json: { files: posted } })
    expect(response.status).toBe(200)
    const { files } = await readJson<{ files: PublicFileReferences }>(response)
    expect(files.manifest.path).toBe('public/manifest.webmanifest')
    expect(files.manifest.url).toStartWith('/admin/api/cms/runtime/files/')
    expect((await harness.cms(files.manifest.url)).status).toBe(401)
    const privateAsset = await harness.cms(files.manifest.url, { cookie: owner })
    expect(await privateAsset.text()).toBe('unsaved')
    expect(privateAsset.headers.get('cache-control')).toBe('private, no-store')
    const viewer = await harness.createRoleUser({ name: 'Reader', slug: 'reader', capabilities: ['site.read'] })
    expect((await harness.cms(files.manifest.url, { cookie: viewer.cookie })).status).toBe(404)
    expect((await harness.cms('/admin/api/cms/runtime/files', { method: 'POST', cookie: viewer.cookie, json: { files: posted } })).status).toBe(200)
    expect((await handleServerRequest(new Request('http://localhost/manifest.webmanifest'), runtime)).status).toBe(404)
    expect((await getDraftSiteDocument(harness.db, MAIN_SCOPE))!.files).toEqual(site.files)
    expect(await getLatestPublishedSiteSnapshot(harness.db)).toBeNull()
  }, 15_000)
})
