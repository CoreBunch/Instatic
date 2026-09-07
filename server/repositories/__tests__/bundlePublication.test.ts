import { afterEach, describe, expect, it } from 'bun:test'
import type { SiteBundle } from '@core/data/bundleSchema'
import { filterSiteBundleForImportSelection } from '@core/data/bundleSelection'
import { parseSiteBundleArchive } from '@core/persistence/cmsTransfer'
import { createSqliteClient } from '../../db/sqlite'
import { runMigrations } from '../../db/runMigrations'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import type { DbClient } from '../../db/client'
import { createDataRow, getDataRow, listDataRows, listDataTables } from '../data'
import { replaceDataRow } from '../data/rows'
import { getDraftSite } from '../site'
import { getDraftSiteDocument } from '../publish'
import {
  createLocale, getContentLocalization, listLocales, saveContentLocalizationDraft,
  saveTableLocalization, scheduleContentLocalizationPublish, setContentLocalizationPublishedVersion,
} from '../localization'
import { exportBundlePublication, restoreBundleLocales, restoreBundlePublication } from '../bundlePublication'
import { createCapabilityTestHarness } from '../../../src/__tests__/helpers/capabilityHarness'
import { handleExportRoute } from '../../handlers/cms/export'
import { handleImportRoute } from '../../handlers/cms/import'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function database() {
  const db = createSqliteClient(':memory:')
  cleanups.push(() => db.close())
  await runMigrations(db, sqliteMigrations)
  await db`insert into site (id, name, settings_json) values ('default', 'Portable', ${{}})`
  return db
}

async function source(db = undefined as DbClient | undefined) {
  db ??= await database()
  const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
  const tree = { rootNodeId: 'root', nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: [], classIds: [], breakpointOverrides: {} } } }
  await createDataRow(db, { id: 'portable-page', tableId: 'pages', cells: { title: 'Source', slug: 'portable', body: tree, seoTitle: 'English SEO' }, slug: 'portable' })
  await createDataRow(db, { id: 'unselected-post', tableId: 'posts', cells: { title: 'Other' }, slug: 'other' })
  await saveContentLocalizationDraft(db, 'portable-page', locale.id, {
    cells: { title: 'Entwurf', seoTitle: 'Deutsches SEO', body: { nodes: { root: { hidden: true } } } },
    slug: 'entwurf', translationMeta: { title: { sourceFingerprint: 'fingerprint', reviewState: 'reviewed' } },
  })
  await saveTableLocalization(db, 'posts', locale.id, '/artikel')
  const snapshot = await getDraftSiteDocument(db, { localeId: locale.id })
  await db`insert into site_snapshots (id, site_json, content_hash, importmap_body, importmap_sha256)
    values ('portable-snapshot', ${snapshot}, 'frozen-hash', '{ "imports": {} }', 'exact-importmap-hash')`
  await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug, public_path, site_snapshot_id, runtime_assets_json)
    values ('portable-version', 'portable-page', ${locale.id}, 1, ${{ title: 'Live title', slug: 'live' }}, 'live', '/de/live', 'portable-snapshot', ${{ scripts: [] }})`
  const bytes = Buffer.from('globalThis.portable = "Grüße";\n')
  await db`insert into published_runtime_assets (id, data_row_version_id, asset_path, public_path, content_type, content_bytes)
    values ('portable-js', 'portable-version', 'entry.js', '/_instatic/assets/portable-version/entry.js', 'text/javascript', ${bytes})`
  await setContentLocalizationPublishedVersion(db, 'portable-page', locale.id, 'portable-version')
  await scheduleContentLocalizationPublish(db, 'portable-page', locale.id, '2026-12-01T12:00:00.000Z', {
    cells: { title: 'Frozen planned update' }, slug: 'scheduled', siteSnapshotId: 'portable-snapshot', publicPath: '/de/scheduled',
  })
  const tables = await listDataTables(db)
  const rows = (await Promise.all(tables.map((table) => listDataRows(db!, table.id)))).flat()
  const publication = await exportBundlePublication(db, rows.map((row) => row.id), tables.map((table) => table.id))
  const bundle: SiteBundle = { schemaVersion: 1, exportedAt: '2026-09-07T12:00:00.000Z', site: (await getDraftSite(db))!, tables, rows, ...publication }
  return { db, locale, bundle, bytes }
}

async function restore(db: DbClient, bundle: SiteBundle) {
  await db.transaction(async (tx) => {
    await tx`delete from data_rows`
    await tx`delete from data_table_localizations`
    await tx`delete from site_locales`
    await restoreBundleLocales(tx, bundle, 'replace')
    for (const row of bundle.rows) await replaceDataRow(tx, row)
    await restoreBundlePublication(tx, bundle, new Set(bundle.rows.map((row) => row.id)), new Set(bundle.tables.map((table) => table.id)), 'replace')
  })
}

describe('portable localized releases', () => {
  it('round-trips sparse drafts, offline source, live target, history joins, scheduled revisions and exact runtime bytes', async () => {
    const original = await source()
    const target = await database()
    await restore(target, original.bundle)
    expect(await listLocales(target)).toEqual(original.bundle.locales)
    const row = await getDataRow(target, 'portable-page', original.locale.id)
    expect(row?.status).toBe('published')
    expect(row?.publicPath).toBe('/de/live')
    expect(row?.cells.title).toBe('Entwurf')
    expect(row?.cells.seoTitle).toBe('Deutsches SEO')
    expect((await getDataRow(target, 'portable-page'))?.status).toBe('draft')
    const exported = await exportBundlePublication(target, original.bundle.rows.map((entry) => entry.id), original.bundle.tables.map((entry) => entry.id))
    expect(exported).toEqual({ locales: original.bundle.locales, localizations: original.bundle.localizations, tableLocalizations: original.bundle.tableLocalizations, versions: original.bundle.versions, siteSnapshots: original.bundle.siteSnapshots, runtimeAssets: original.bundle.runtimeAssets })
    expect(exported.versions?.[0].cells).toEqual({ title: 'Live title', slug: 'live' })
    expect(Buffer.from(exported.runtimeAssets![0].bytesBase64, 'base64')).toEqual(original.bytes)
    expect((await getContentLocalization(target, 'portable-page', original.locale.id))?.scheduledRevision?.siteSnapshotId).toBe('portable-snapshot')
  })

  it('rejects missing release references atomically and never activates inherited content', async () => {
    const { bundle } = await source()
    const target = await database()
    const broken = structuredClone(bundle)
    broken.versions = []
    await expect(restore(target, broken)).rejects.toThrow('missing or mismatched')
    expect(await getDataRow(target, 'portable-page')).toBeNull()
    expect(await listLocales(target)).toHaveLength(1)
  })

  it('keeps immutable history immutable and refuses language identity collisions on merge', async () => {
    const { bundle } = await source()
    const target = await database()
    await restore(target, bundle)
    const conflict = structuredClone(bundle)
    conflict.versions![0].cells.title = 'Changed old version'
    await expect(target.transaction((tx) => restoreBundlePublication(tx, conflict, new Set(['portable-page']), new Set(['pages']), 'merge-overwrite'))).rejects.toThrow('different immutable content')
    expect((await getDataRow(target, 'portable-page', bundle.versions![0].localeId))?.status).toBe('published')
    const languageCollision = structuredClone(bundle)
    languageCollision.locales![0].code = 'fr'
    await expect(restoreBundleLocales(target, languageCollision, 'merge-overwrite')).rejects.toThrow('different local language')
  })

  it('prunes unselected release dependencies and does not export snapshots through an own-row permission scope', async () => {
    const { db, bundle } = await source()
    const selected = filterSiteBundleForImportSelection(bundle, {
      includeSite: false, tables: [{ tableId: 'posts' }], includeMedia: false, includeMediaFolders: false, includeRedirects: false,
    })
    expect(selected.localizations?.every((variant) => variant.rowId === 'unselected-post')).toBe(true)
    expect(selected.versions).toEqual([])
    expect(selected.siteSnapshots).toEqual([])
    expect(selected.runtimeAssets).toEqual([])
    const restricted = await exportBundlePublication(db, ['portable-page'], ['pages'], false)
    expect(restricted.siteSnapshots).toEqual([])
    expect(restricted.localizations?.every((variant) => variant.availability === 'offline' && variant.activeVersionId === null && variant.scheduledPublishAt === null)).toBe(true)
  })

  it('transports locale state through real ZIP export and the authorized HTTP replace handler', async () => {
    const from = await createCapabilityTestHarness()
    cleanups.push(() => from.cleanup())
    const cookie = await from.setupOwner()
    const original = await source(from.db)
    const exportRequest = new Request('http://localhost/admin/api/cms/export')
    exportRequest.headers.set('cookie', cookie)
    const exported = await handleExportRoute(exportRequest, from.db)
    expect(exported?.status).toBe(200)
    const bundle = parseSiteBundleArchive(new Uint8Array(await exported!.arrayBuffer()))!
    const into = await createCapabilityTestHarness()
    cleanups.push(() => into.cleanup())
    const targetCookie = await into.stepUp(await into.setupOwner())
    const importRequest = new Request('http://localhost/admin/api/cms/import?strategy=replace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle) })
    importRequest.headers.set('cookie', targetCookie)
    const imported = await handleImportRoute(importRequest, into.db)
    expect(imported?.status).toBe(200)
    expect((await getDataRow(into.db, 'portable-page', original.locale.id))?.publicPath).toBe('/de/live')
    expect((await exportBundlePublication(into.db, ['portable-page'], ['pages'])).runtimeAssets).toEqual(original.bundle.runtimeAssets)
  })
})
