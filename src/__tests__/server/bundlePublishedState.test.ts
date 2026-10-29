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
import { createDataRow, saveDataRowDraft, getDataRow, scheduleDataRowPublish } from '../../../server/repositories/data'
import { getPublishedDataRowByRoute } from '../../../server/repositories/data/publish'
import { getPublishedPageBySlug } from '../../../server/repositories/publish'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { publishDataRow } from '../../../server/publish/publishRow'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import { handleImportArchiveRoute } from '../../../server/handlers/cms/importArchive'
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
