import { unzipSync, zipSync, strToU8 } from 'fflate'
import { BUNDLE_ARCHIVE_MANIFEST_PATH } from '@core/data/bundleArchive'
import { createCapabilityTestHarness } from '../helpers/capabilityHarness'
import { prefetchLoopData } from '../../../server/publish/loopPrefetch'
import '@core/loops/sources'
import '@modules/base'
import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { createTestDb } from '../helpers/createTestDb'
import { makeSite, makePage, makeNode } from '../fixtures'
import { createUser } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import { createSessionToken, hashSessionToken, SESSION_COOKIE_NAME, sessionExpiry } from '../../../server/auth/tokens'
import { saveDraftSite, getDraftSite } from '../../../server/repositories/site'
import { createDataRow, saveDataRowDraft, getDataRow, scheduleDataRowPublish, updateDataRowStatus } from '../../../server/repositories/data'
import { getPublishedDataRowByRoute } from '../../../server/repositories/data/publish'
import { getPublishedPageBySlug } from '../../../server/repositories/publish'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import { handleImportArchiveRoute } from '../../../server/handlers/cms/importArchive'
import { handleImportRoute } from '../../../server/handlers/cms/import'
import { getPublishedRuntimeAsset } from '../../../server/repositories/runtimeAsset'
import { listDataRowVersions } from '../../../server/repositories/data/versions'
import { parseSiteBundleArchive } from '@core/persistence/cmsTransfer'
import { pageToCells } from '@core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import type { DbClient } from '../../../server/db/client'

/** A transfer needs two independent databases, including when running the PostgreSQL gate. */
async function createTransferTestDb() {
  if (process.env.DB !== 'postgres') return createTestDb()
  const rootUrl = process.env.TEST_POSTGRES_URL
  if (!rootUrl) throw new Error('TEST_POSTGRES_URL is required')
  const admin = new SQL(rootUrl)
  const database = `backup_test_${crypto.randomUUID().replaceAll('-', '')}`
  await admin.unsafe(`create database "${database}"`)
  const url = new URL(rootUrl)
  url.pathname = `/${database}`
  try {
    const fixture = await createTestDb(url.toString())
    return { db: fixture.db, cleanup: async () => {
      try { await fixture.cleanup() } finally {
        await admin.unsafe(`drop database "${database}"`)
        await admin.close()
      }
    } }
  } catch (err) {
    await admin.unsafe(`drop database "${database}"`)
    await admin.close()
    throw err
  }
}

async function owner(db: DbClient) {
  await createUser(db, { id: 'owner', email: 'backup@example.test', displayName: 'Owner', passwordHash: 'unused', roleId: 'owner', allowOwnerRole: true })
  const token = createSessionToken()
  await createSession(db, { idHash: await hashSessionToken(token), userId: 'owner', expiresAt: sessionExpiry(), ipAddress: null, userAgent: null, stepUpExpiresAt: new Date(Date.now() + 3600000) })
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

test('a ZIP restore keeps published content and newer drafts separate', async () => {
  const source = await createTransferTestDb()
  const target = await createTransferTestDb()
  try {
    const sourceHeaders = await owner(source.db)
    const targetHeaders = await owner(target.db)
    const shell = makeSite({ name: 'Published site', files: [{ id: 'runtime', path: 'runtime.js', type: 'script', content: 'window.backupValue = "published"', createdAt: 1, updatedAt: 1 }] })
    const page = makePage({ nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text'] }), text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: 'Published home', tag: 'h1' } }) } })
    await saveDraftSite(source.db, MAIN_SCOPE, shell)
    await createDataRow(source.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', slug: page.slug, cells: pageToCells(page) })
    await createDataRow(source.db, MAIN_SCOPE, { id: 'post', tableId: 'posts', slug: 'event', cells: { title: 'Friday', body: 'Published body' } })
    await publishDraftSite(source.db, 'owner')
    await publishDataRow(source.db, 'post', 'owner')
    await publishDataRow(source.db, 'post', 'owner')
    await createDataRow(source.db, MAIN_SCOPE, { id: 'scheduled', tableId: 'posts', slug: 'later', cells: { title: 'Scheduled' } })
    await scheduleDataRowPublish(source.db, MAIN_SCOPE, 'scheduled', '2099-01-01T00:00:00.000Z')
    await saveDraftSite(source.db, MAIN_SCOPE, { ...shell, name: 'Draft site' })
    await saveDataRowDraft(source.db, MAIN_SCOPE, 'post', { slug: 'unconfirmed', cells: { title: 'Monday', body: 'Private draft' } })
    const draft = structuredClone(page)
    draft.nodes.text.props.text = 'Private home'
    await saveDataRowDraft(source.db, MAIN_SCOPE, page.id, { slug: page.slug, cells: pageToCells(draft) })
    const exportRequest = new Request('http://localhost/admin/api/cms/export')
    exportRequest.headers.set('cookie', sourceHeaders.cookie)
    const exported = await handleExportRoute(exportRequest, source.db, MAIN_SCOPE)
    expect(exported?.status).toBe(200)
    const archive = await exported!.arrayBuffer()
    const manifest = parseSiteBundleArchive(new Uint8Array(archive))
    expect(manifest.publication?.files.length).toBeGreaterThan(0)
    const importRequest = new Request('http://localhost/admin/api/cms/import/archive?strategy=replace', { method: 'POST', body: archive })
    importRequest.headers.set('cookie', targetHeaders.cookie)
    const imported = await handleImportArchiveRoute(importRequest, target.db, MAIN_SCOPE)
    expect(imported?.status, await imported?.text()).toBe(200)
    expect((await getDataRow(target.db, MAIN_SCOPE, 'post'))?.cells.title).toBe('Monday')
    expect((await getDraftSite(target.db, MAIN_SCOPE))?.name).toBe('Draft site')
    expect((await getPublishedDataRowByRoute(target.db, '/posts', 'event'))?.cells.title).toBe('Friday')
    const publishedPage = await getPublishedPageBySlug(target.db, 'index')
    const loopPage = makePage({ nodes: { root: makeNode({ id: 'root', moduleId: 'base.body', children: ['loop'] }), loop: makeNode({ id: 'loop', moduleId: 'base.loop', props: { sourceId: 'data.rows', filters: { tableId: 'posts' }, limit: 10 } }) } })
    const loop = await prefetchLoopData(loopPage, publishedPage!.site, target.db)
    expect(loop.get('loop')?.items.map((item) => item.fields.title)).toEqual(['Friday'])
    expect(publishedPage?.site.name).toBe('Published site')
    expect(publishedPage?.site.pages[0]?.nodes.text.props.text).toBe('Published home')
    expect(await getPublishedDataRowByRoute(target.db, '/posts', 'unconfirmed')).toBeNull()
    expect((await getDataRow(target.db, MAIN_SCOPE, 'scheduled'))?.scheduledPublishAt).toBe('2099-01-01T00:00:00.000Z')
    expect((await listDataRowVersions(target.db, 'post')).map((v) => v.versionNumber)).toEqual([2, 1])
    const runtimePath = publishedPage?.runtimeAssets?.scripts[0]?.src
    expect(runtimePath).toBeTruthy()
    const sourceFile = await getPublishedRuntimeAsset(source.db, runtimePath!)
    const targetFile = await getPublishedRuntimeAsset(target.db, runtimePath!)
    expect(targetFile?.bytes).toEqual(sourceFile?.bytes)
  } finally { await source.cleanup(); await target.cleanup() }
}, 30000)

async function postBackup() {
  const source = await createTransferTestDb()
  try {
    const headers = await owner(source.db)
    await saveDraftSite(source.db, MAIN_SCOPE, makeSite())
    await createDataRow(source.db, MAIN_SCOPE, { id: 'post', tableId: 'posts', slug: 'event', cells: { title: 'Friday' } })
    await publishDataRow(source.db, 'post', 'owner')
    await saveDataRowDraft(source.db, MAIN_SCOPE, 'post', { slug: 'draft-event', cells: { title: 'Monday' } })
    const req = new Request('http://localhost/admin/api/cms/export')
    req.headers.set('cookie', headers.cookie)
    const response = await handleExportRoute(req, source.db, MAIN_SCOPE)
    return new Uint8Array(await response!.arrayBuffer())
  } finally { await source.cleanup() }
}

for (const strategy of ['merge-add', 'merge-overwrite'] as const) {
  test(`${strategy} preserves the matching row's publication according to the strategy`, async () => {
    const archive = await postBackup()
    const target = await createTransferTestDb()
    try {
      const headers = await owner(target.db)
      await saveDraftSite(target.db, MAIN_SCOPE, makeSite())
      await createDataRow(target.db, MAIN_SCOPE, { id: 'post', tableId: 'posts', slug: 'local', cells: { title: 'Local published' } })
      await publishDataRow(target.db, 'post', 'owner')
      for (let attempt = 0; attempt < 2; attempt++) {
        const req = new Request(`http://localhost/admin/api/cms/import/archive?strategy=${strategy}`, { method: 'POST', body: archive })
        req.headers.set('cookie', headers.cookie)
        const response = await handleImportArchiveRoute(req, target.db, MAIN_SCOPE)
        expect(response?.status, await response?.text()).toBe(200)
      }
      if (strategy === 'merge-add') {
        expect((await getPublishedDataRowByRoute(target.db, '/posts', 'local'))?.cells.title).toBe('Local published')
        expect((await getDataRow(target.db, MAIN_SCOPE, 'post'))?.cells.title).toBe('Local published')
      } else {
        expect((await getPublishedDataRowByRoute(target.db, '/posts', 'event'))?.cells.title).toBe('Friday')
        expect((await getDataRow(target.db, MAIN_SCOPE, 'post'))?.cells.title).toBe('Monday')
        expect(await getPublishedDataRowByRoute(target.db, '/posts', 'local')).toBeNull()
      }
    } finally { await target.cleanup() }
  })
}

test('published restore requires publishing rights in addition to import permission', async () => {
  const archive = await postBackup()
  const harness = await createCapabilityTestHarness()
  try {
    await harness.setupOwner()
    const importer = await harness.createRoleUser({ name: 'Importer', slug: 'backup-importer', capabilities: ['data.import', 'site.structure.edit'] })
    const response = await harness.cms('/admin/api/cms/import/archive?strategy=merge-add', { method: 'POST', cookie: importer.cookie, body: archive })
    expect(response.status).toBe(403)
    expect(await getDataRow(harness.db, MAIN_SCOPE, 'post')).toBeNull()
  } finally { await harness.cleanup() }
})

test('invalid publication references fail before replace deletes local data', async () => {
  const archive = await postBackup()
  const entries = unzipSync(archive)
  const manifest = parseSiteBundleArchive(archive)
  manifest.publication!.rows.find((row) => row.rowId === 'post')!.activeVersionId = 'missing-version'
  entries[BUNDLE_ARCHIVE_MANIFEST_PATH] = strToU8(JSON.stringify(manifest))
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    await createDataRow(target.db, MAIN_SCOPE, { id: 'local', tableId: 'posts', slug: 'local', cells: { title: 'Keep me' } })
    const req = new Request('http://localhost/admin/api/cms/import/archive?strategy=replace', { method: 'POST', body: zipSync(entries, { level: 0 }) })
    req.headers.set('cookie', headers.cookie)
    const response = await handleImportArchiveRoute(req, target.db, MAIN_SCOPE)
    expect(response?.status).toBe(400)
    expect((await getDataRow(target.db, MAIN_SCOPE, 'local'))?.cells.title).toBe('Keep me')
  } finally { await target.cleanup() }
})

test('selecting one row includes only its publication and leaves other rows alone', async () => {
  const archive = await postBackup()
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    const selection = { includeSite: false, tables: [{ tableId: 'posts', rowIds: ['post'] }], includeMedia: false, includeMediaFolders: false, includeRedirects: false }
    const req = new Request(`http://localhost/admin/api/cms/import/archive?strategy=merge-add&selection=${encodeURIComponent(JSON.stringify(selection))}`, { method: 'POST', body: archive })
    req.headers.set('cookie', headers.cookie)
    const response = await handleImportArchiveRoute(req, target.db, MAIN_SCOPE)
    expect(response?.status, await response?.text()).toBe(200)
    expect((await getPublishedDataRowByRoute(target.db, '/posts', 'event'))?.cells.title).toBe('Friday')
    expect(await getDraftSite(target.db, MAIN_SCOPE)).toBeNull()
  } finally { await target.cleanup() }
})

async function pageBackup() {
  const source = await createTransferTestDb()
  try {
    const headers = await owner(source.db)
    await saveDraftSite(source.db, MAIN_SCOPE, makeSite({ files: [{ id: 'script', path: 'runtime.js', type: 'script', content: 'window.backupValue = "original"', createdAt: 1, updatedAt: 1 }] }))
    for (const id of ['first', 'second']) {
      const page = makePage({ id, slug: id })
      await createDataRow(source.db, MAIN_SCOPE, { id, tableId: 'pages', slug: id, cells: pageToCells(page) })
    }
    await publishDraftSite(source.db, 'owner')
    const req = new Request('http://localhost/admin/api/cms/export')
    req.headers.set('cookie', headers.cookie)
    const response = await handleExportRoute(req, source.db, MAIN_SCOPE)
    return new Uint8Array(await response!.arrayBuffer())
  } finally { await source.cleanup() }
}

for (const corruption of ['missing', 'wrong-size', 'bad-crc'] as const) {
  test(`a ${corruption} runtime file is rejected before replacing local data`, async () => {
    const archive = await pageBackup()
    const entries = unzipSync(archive)
    if (corruption === 'missing') delete entries['runtime/0']
    if (corruption === 'wrong-size') entries['runtime/0'] = strToU8('wrong')
    const corrupt = zipSync(entries, { level: 0 })
    if (corruption === 'bad-crc') {
      const view = new DataView(corrupt.buffer, corrupt.byteOffset, corrupt.byteLength)
      const manifestSize = view.getUint32(18, true)
      const nextHeader = 30 + view.getUint16(26, true) + view.getUint16(28, true) + manifestSize
      view.setUint32(nextHeader + 14, 0, true)
    }
    const target = await createTransferTestDb()
    try {
      const headers = await owner(target.db)
      await createDataRow(target.db, MAIN_SCOPE, { id: 'local', tableId: 'posts', slug: 'local', cells: { title: 'Keep me' } })
      const req = new Request('http://localhost/admin/api/cms/import/archive?strategy=replace', { method: 'POST', body: corrupt })
      req.headers.set('cookie', headers.cookie)
      const response = await handleImportArchiveRoute(req, target.db, MAIN_SCOPE)
      expect(response?.status).toBe(400)
      expect((await getDataRow(target.db, MAIN_SCOPE, 'local'))?.cells.title).toBe('Keep me')
    } finally { await target.cleanup() }
  })
}

test('selecting a page retains its original runtime archive index', async () => {
  const archive = await pageBackup()
  const manifest = parseSiteBundleArchive(archive)
  const lastFile = manifest.publication!.files.at(-1)!
  const selectedRow = manifest.publication!.rows.find((row) => row.versions.some((version) => version.id === lastFile.versionId))!
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    const selection = { includeSite: false, tables: [{ tableId: 'pages', rowIds: [selectedRow.rowId] }], includeMedia: false, includeMediaFolders: false, includeRedirects: false }
    const req = new Request(`http://localhost/admin/api/cms/import/archive?strategy=merge-add&selection=${encodeURIComponent(JSON.stringify(selection))}`, { method: 'POST', body: archive })
    req.headers.set('cookie', headers.cookie)
    const response = await handleImportArchiveRoute(req, target.db, MAIN_SCOPE)
    expect(response?.status, await response?.text()).toBe(200)
    expect(await getPublishedPageBySlug(target.db, selectedRow.rowId)).not.toBeNull()
    expect((await getPublishedRuntimeAsset(target.db, lastFile.publicPath))?.bytes).toEqual(Buffer.from(lastFile.bytesBase64!, 'base64'))
    expect(await getDataRow(target.db, MAIN_SCOPE, selectedRow.rowId === 'first' ? 'second' : 'first')).toBeNull()
  } finally { await target.cleanup() }
})

test('a published route collision rolls back a merge even when draft slugs differ', async () => {
  const archive = await postBackup()
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    await createDataRow(target.db, MAIN_SCOPE, { id: 'local', tableId: 'posts', slug: 'event', cells: { title: 'Local published' } })
    await publishDataRow(target.db, 'local', 'owner')
    await saveDataRowDraft(target.db, MAIN_SCOPE, 'local', { slug: 'local-draft', cells: { title: 'Local draft' } })
    const req = new Request('http://localhost/admin/api/cms/import/archive?strategy=merge-add', { method: 'POST', body: archive })
    req.headers.set('cookie', headers.cookie)
    const response = await handleImportArchiveRoute(req, target.db, MAIN_SCOPE)
    expect(response?.status).toBe(400)
    expect(await getDataRow(target.db, MAIN_SCOPE, 'post')).toBeNull()
    expect((await getPublishedDataRowByRoute(target.db, '/posts', 'event'))?.cells.title).toBe('Local published')
  } finally { await target.cleanup() }
})

// ---------------------------------------------------------------------------
// Bundles without a `publication` section (every export before publication
// travelled in the bundle). Their rows still say `published`, but the bundle
// carries no version to serve, so the import must not leave them reading live.
// ---------------------------------------------------------------------------

/** The same archive as an older export wrote it: rows and their status, no publication. */
function withoutPublication(archive: Uint8Array): Uint8Array {
  const manifest = parseSiteBundleArchive(archive)
  delete manifest.publication
  const entries: Record<string, Uint8Array> = { [BUNDLE_ARCHIVE_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)) }
  for (const [path, bytes] of Object.entries(unzipSync(archive))) {
    if (path !== BUNDLE_ARCHIVE_MANIFEST_PATH && !path.startsWith('runtime/')) entries[path] = bytes
  }
  return zipSync(entries, { level: 0 })
}

/** A bundle without publication whose post rows (id = slug) were all published on the source. */
async function publishedPostsBundle(ids: readonly string[]): Promise<Uint8Array> {
  const source = await createTransferTestDb()
  try {
    const headers = await owner(source.db)
    await saveDraftSite(source.db, MAIN_SCOPE, makeSite())
    for (const id of ids) {
      await createDataRow(source.db, MAIN_SCOPE, { id, tableId: 'posts', slug: id, cells: { title: `Backup ${id}` } })
      await publishDataRow(source.db, id, 'owner')
    }
    const req = new Request('http://localhost/admin/api/cms/export')
    req.headers.set('cookie', headers.cookie)
    const response = await handleExportRoute(req, source.db, MAIN_SCOPE)
    return withoutPublication(new Uint8Array(await response!.arrayBuffer()))
  } finally { await source.cleanup() }
}

async function importArchive(db: DbClient, cookie: string, strategy: string, archive: Uint8Array): Promise<Response> {
  const req = new Request(`http://localhost/admin/api/cms/import/archive?strategy=${strategy}`, { method: 'POST', body: archive })
  req.headers.set('cookie', cookie)
  const response = await handleImportArchiveRoute(req, db, MAIN_SCOPE)
  return response!
}

test('a bundle without publication imports its published rows as drafts', async () => {
  const source = await createTransferTestDb()
  const target = await createTransferTestDb()
  try {
    const sourceHeaders = await owner(source.db)
    const targetHeaders = await owner(target.db)
    const page = makePage()
    await saveDraftSite(source.db, MAIN_SCOPE, makeSite())
    await createDataRow(source.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', slug: page.slug, cells: pageToCells(page) })
    await createDataRow(source.db, MAIN_SCOPE, { id: 'post', tableId: 'posts', slug: 'event', cells: { title: 'Friday' } })
    await createDataRow(source.db, MAIN_SCOPE, { id: 'note', tableId: 'posts', slug: 'note', cells: { title: 'Unfinished' } })
    await createDataRow(source.db, MAIN_SCOPE, { id: 'scheduled', tableId: 'posts', slug: 'later', cells: { title: 'Scheduled' } })
    await publishDraftSite(source.db, 'owner')
    await publishDataRow(source.db, 'post', 'owner')
    await scheduleDataRowPublish(source.db, MAIN_SCOPE, 'scheduled', '2099-01-01T00:00:00.000Z')
    const exportRequest = new Request('http://localhost/admin/api/cms/export')
    exportRequest.headers.set('cookie', sourceHeaders.cookie)
    const exported = await handleExportRoute(exportRequest, source.db, MAIN_SCOPE)
    const archive = withoutPublication(new Uint8Array(await exported!.arrayBuffer()))
    // The fixture is what an older export looked like: published rows, nothing to serve.
    const manifest = parseSiteBundleArchive(archive)
    expect(manifest.publication).toBeUndefined()
    expect(manifest.rows.filter((row) => row.status === 'published').map((row) => row.id).sort()).toEqual([page.id, 'post'].sort())

    const response = await importArchive(target.db, targetHeaders.cookie, 'replace', archive)
    expect(response.status, await response.clone().text()).toBe(200)

    for (const id of [page.id, 'post']) {
      const row = await getDataRow(target.db, MAIN_SCOPE, id)
      expect(row?.status).toBe('draft')
      expect(row?.publishedAt).toBeNull()
    }
    expect((await getDataRow(target.db, MAIN_SCOPE, 'note'))?.status).toBe('draft')
    // A schedule is a real pending publish, not a claim about a missing version.
    const scheduled = await getDataRow(target.db, MAIN_SCOPE, 'scheduled')
    expect(scheduled?.status).toBe('scheduled')
    expect(scheduled?.scheduledPublishAt).toBe('2099-01-01T00:00:00.000Z')
    expect(await getPublishedPageBySlug(target.db, page.slug)).toBeNull()
    expect(await getPublishedDataRowByRoute(target.db, '/posts', 'event')).toBeNull()
    expect((await response.json()).rowsImportedAsDraft).toBe(2)

    // The imported draft publishes the ordinary way.
    await publishDataRow(target.db, 'post', 'owner')
    expect((await getPublishedDataRowByRoute(target.db, '/posts', 'event'))?.cells.title).toBe('Friday')
  } finally { await source.cleanup(); await target.cleanup() }
}, 30000)

test('merge-add of a bundle without publication adds drafts and leaves live rows alone', async () => {
  const archive = await publishedPostsBundle(['post'])
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    await saveDraftSite(target.db, MAIN_SCOPE, makeSite())
    await createDataRow(target.db, MAIN_SCOPE, { id: 'local', tableId: 'posts', slug: 'local', cells: { title: 'Local published' } })
    await publishDataRow(target.db, 'local', 'owner')

    const response = await importArchive(target.db, headers.cookie, 'merge-add', archive)
    expect(response.status, await response.clone().text()).toBe(200)

    expect((await getDataRow(target.db, MAIN_SCOPE, 'post'))?.status).toBe('draft')
    expect(await getPublishedDataRowByRoute(target.db, '/posts', 'post')).toBeNull()
    expect((await getDataRow(target.db, MAIN_SCOPE, 'local'))?.status).toBe('published')
    expect((await getPublishedDataRowByRoute(target.db, '/posts', 'local'))?.cells.title).toBe('Local published')
    expect((await response.json()).rowsImportedAsDraft).toBe(1)
  } finally { await target.cleanup() }
})

test('merge-overwrite of a bundle without publication keeps live rows live and drafts as drafts', async () => {
  const archive = await publishedPostsBundle(['live', 'draft', 'new'])
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    await saveDraftSite(target.db, MAIN_SCOPE, makeSite())
    await createDataRow(target.db, MAIN_SCOPE, { id: 'live', tableId: 'posts', slug: 'local-live', cells: { title: 'Local live' } })
    await publishDataRow(target.db, 'live', 'owner')
    await createDataRow(target.db, MAIN_SCOPE, { id: 'draft', tableId: 'posts', slug: 'local-draft', cells: { title: 'Local draft' } })

    const response = await importArchive(target.db, headers.cookie, 'merge-overwrite', archive)
    expect(response.status, await response.clone().text()).toBe(200)

    // A row that is live stays live on its own published version; the bundle only replaced its draft.
    const live = await getDataRow(target.db, MAIN_SCOPE, 'live')
    expect(live?.status).toBe('published')
    expect(live?.cells.title).toBe('Backup live')
    expect((await getPublishedDataRowByRoute(target.db, '/posts', 'local-live'))?.cells.title).toBe('Local live')
    // A row that was a draft stays a draft, and a new row arrives as one.
    expect((await getDataRow(target.db, MAIN_SCOPE, 'draft'))?.status).toBe('draft')
    expect((await getDataRow(target.db, MAIN_SCOPE, 'new'))?.status).toBe('draft')
    for (const slug of ['live', 'draft', 'new']) {
      expect(await getPublishedDataRowByRoute(target.db, '/posts', slug)).toBeNull()
    }
    expect((await response.json()).rowsImportedAsDraft).toBe(1)
  } finally { await target.cleanup() }
})

test('merge-overwrite of a bundle without publication leaves a retracted row offline', async () => {
  const archive = await publishedPostsBundle(['gone'])
  const harness = await createCapabilityTestHarness()
  try {
    await harness.setupOwner()
    await createDataRow(harness.db, MAIN_SCOPE, { id: 'gone', tableId: 'posts', slug: 'gone', cells: { title: 'Taken down' } })
    await publishDataRow(harness.db, 'gone', null)
    await updateDataRowStatus(harness.db, MAIN_SCOPE, 'gone', 'unpublished')
    expect(await getPublishedDataRowByRoute(harness.db, '/posts', 'gone')).toBeNull()

    // An importer who may not publish: the bundle carries no publication, so no publishing rights are asked for.
    const importer = await harness.createRoleUser({ name: 'Importer', slug: 'bundle-importer', capabilities: ['data.import', 'site.structure.edit'] })
    const response = await harness.cms('/admin/api/cms/import/archive?strategy=merge-overwrite', { method: 'POST', cookie: importer.cookie, body: archive })
    expect(response.status, await response.clone().text()).toBe(200)

    expect((await getPublishedDataRowByRoute(harness.db, '/posts', 'gone'))?.cells.title).toBeUndefined()
    expect((await getDataRow(harness.db, MAIN_SCOPE, 'gone'))?.status).toBe('unpublished')
  } finally { await harness.cleanup() }
})

test('the JSON import endpoint applies the same rule to a bundle without publication', async () => {
  const manifest = parseSiteBundleArchive(await publishedPostsBundle(['post']))
  delete manifest.media
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    const req = new Request('http://localhost/admin/api/cms/import?strategy=merge-add', { method: 'POST', body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' } })
    req.headers.set('cookie', headers.cookie)
    const response = await handleImportRoute(req, target.db, MAIN_SCOPE)
    expect(response?.status, await response?.clone().text()).toBe(200)
    expect((await getDataRow(target.db, MAIN_SCOPE, 'post'))?.status).toBe('draft')
    expect(await getPublishedDataRowByRoute(target.db, '/posts', 'post')).toBeNull()
    expect((await response!.json()).rowsImportedAsDraft).toBe(1)
  } finally { await target.cleanup() }
})

// ---------------------------------------------------------------------------
// A `scheduled` row is a pending publish: on main the scheduler publishes its
// cells when it falls due. Importing one is therefore a publish, with the same
// rights a restore of published versions needs.
// ---------------------------------------------------------------------------

/** A bundle whose only post is scheduled for a moment that has already passed. */
async function scheduledPostBundle(): Promise<Uint8Array> {
  const source = await createTransferTestDb()
  try {
    const headers = await owner(source.db)
    await saveDraftSite(source.db, MAIN_SCOPE, makeSite())
    await createDataRow(source.db, MAIN_SCOPE, { id: 'later', tableId: 'posts', slug: 'later', cells: { title: 'Never approved' } })
    await scheduleDataRowPublish(source.db, MAIN_SCOPE, 'later', '2020-01-01T00:00:00.000Z')
    const req = new Request('http://localhost/admin/api/cms/export')
    req.headers.set('cookie', headers.cookie)
    const response = await handleExportRoute(req, source.db, MAIN_SCOPE)
    return new Uint8Array(await response!.arrayBuffer())
  } finally { await source.cleanup() }
}

for (const endpoint of ['archive', 'json'] as const) {
  test(`importing a scheduled row through the ${endpoint} endpoint requires publishing rights`, async () => {
    const archive = await scheduledPostBundle()
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const importer = await harness.createRoleUser({ name: 'Importer', slug: `schedule-importer-${endpoint}`, capabilities: ['data.import', 'site.structure.edit'] })
      const manifest = parseSiteBundleArchive(archive)
      delete manifest.media
      const response = endpoint === 'archive'
        ? await harness.cms('/admin/api/cms/import/archive?strategy=merge-add', { method: 'POST', cookie: importer.cookie, body: archive })
        : await harness.cms('/admin/api/cms/import?strategy=merge-add', { method: 'POST', cookie: importer.cookie, body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' } })

      // Whatever the import answered, the scheduler must find nothing of the importer's to publish.
      await tickPublishScheduler(harness.db)
      expect((await getPublishedDataRowByRoute(harness.db, '/posts', 'later'))?.cells.title).toBeUndefined()
      expect(response.status, await response.clone().text()).toBe(403)
      expect(await getDataRow(harness.db, MAIN_SCOPE, 'later')).toBeNull()
    } finally { await harness.cleanup() }
  })
}

test('an importer who may publish keeps the schedule of an imported row', async () => {
  const archive = await scheduledPostBundle()
  const target = await createTransferTestDb()
  try {
    const headers = await owner(target.db)
    const response = await importArchive(target.db, headers.cookie, 'merge-add', archive)
    expect(response.status, await response.clone().text()).toBe(200)
    const row = await getDataRow(target.db, MAIN_SCOPE, 'later')
    expect(row?.status).toBe('scheduled')
    expect(row?.scheduledPublishAt).toBe('2020-01-01T00:00:00.000Z')
  } finally { await target.cleanup() }
})

test('merge-overwrite of a bundle without publication cancels the pending schedule of a row it replaces', async () => {
  const archive = await publishedPostsBundle(['soon'])
  const harness = await createCapabilityTestHarness()
  try {
    await harness.setupOwner()
    await createDataRow(harness.db, MAIN_SCOPE, { id: 'soon', tableId: 'posts', slug: 'soon', cells: { title: 'Approved for release' } })
    await scheduleDataRowPublish(harness.db, MAIN_SCOPE, 'soon', '2020-01-01T00:00:00.000Z')

    const importer = await harness.createRoleUser({ name: 'Importer', slug: 'schedule-overwriter', capabilities: ['data.import', 'site.structure.edit'] })
    const response = await harness.cms('/admin/api/cms/import/archive?strategy=merge-overwrite', { method: 'POST', cookie: importer.cookie, body: archive })
    expect(response.status, await response.clone().text()).toBe(200)

    // The schedule was for the content the import replaced, so nothing is left for the scheduler.
    await tickPublishScheduler(harness.db)
    expect((await getPublishedDataRowByRoute(harness.db, '/posts', 'soon'))?.cells.title).toBeUndefined()
    const row = await getDataRow(harness.db, MAIN_SCOPE, 'soon')
    expect(row?.cells.title).toBe('Backup soon')
    expect(row?.status).toBe('draft')
    expect(row?.scheduledPublishAt).toBeNull()
    expect((await response.json()).rowsImportedAsDraft).toBe(1)
  } finally { await harness.cleanup() }
})
