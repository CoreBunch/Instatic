import { afterEach, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import { makePage, makeSite } from '../../../../src/__tests__/publisher/helpers'
import { getPublishedPageSnapshotById } from '../../publish'
import { loadPublishedRouteInventory } from '../../../publish/publishedRoutes'
import { parseSiteDocument } from '@core/page-tree'
import {
  cancelContentLocalizationSchedule,
  createLocale,
  getContentLocalization,
  getDefaultLocale,
  getTableLocalization,
  listContentLocalizations,
  listDueContentLocalizationSchedules,
  listLocales,
  LocalizationError,
  saveContentLocalizationDraft,
  saveTableLocalization,
  scheduleContentLocalizationPublish,
  setContentLocalizationAvailability,
  setContentLocalizationPublishedVersion,
  updateLocale,
} from '..'

const clients: DbClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((db) => db.close()))
})

async function database(beforeLocalization = false): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  clients.push(db)
  await runMigrations(db, beforeLocalization ? sqliteMigrations.filter((m) => m.id !== '027_content_localization') : sqliteMigrations)
  return db
}

async function seedRow(db: DbClient, id: string, cells: Record<string, unknown> = { title: 'Draft', slug: id }, tableId = 'posts'): Promise<void> {
  await db`insert into data_rows (id, table_id, cells_json, slug) values (${id}, ${tableId}, ${cells}, ${typeof cells.slug === 'string' ? cells.slug : id})`
}

async function seedVersion(db: DbClient, rowId: string, id: string, localeId: string, versionNumber: number): Promise<void> {
  await db`
    insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug)
    values (${id}, ${rowId}, ${localeId}, ${versionNumber}, ${{ title: 'Live snapshot', slug: 'live' }}, ${'live'})
  `
}

async function secondLocale(db: DbClient) {
  return createLocale(db, { code: 'de-DE', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
}

describe('localization migration', () => {
  it('preserves the primary draft, live history, snapshot joins and scheduled revisions', async () => {
    const db = await database(true)
    await db`insert into site (id, name, settings_json) values ('default', 'Example', ${{ site: { settings: { language: 'ar' } } }})`
    const tree = { rootNodeId: 'root', nodes: { root: { id: 'root', props: { text: 'Draft body' } } } }
    await seedRow(db, 'page', { title: 'Draft title', slug: 'draft-page', body: tree }, 'pages')
    await seedRow(db, 'post', { title: 'Scheduled title', body: '# Keep Markdown' })
    await seedRow(db, 'template', { title: 'Shell', body: tree, templateEnabled: true }, 'pages')
    const siteInput = makeSite({ layouts: [], pages: [
      { ...makePage({ root: { moduleId: 'base.text', props: { text: 'Published body' } } }), id: 'page', slug: 'index' },
      { ...makePage({ root: { moduleId: 'base.container' } }), id: 'template', template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 } },
    ] })
    const site = { ...siteInput, ...parseSiteDocument(siteInput) }
    await db`insert into site_snapshots (id, site_json, content_hash) values ('snapshot', ${site}, 'hash')`
    await db`
      insert into data_row_versions (id, row_id, version_number, cells_json, slug, site_snapshot_id, runtime_assets_json)
      values ('v1', 'page', 1, ${{ title: 'Old title', slug: 'old' }}, 'old', 'snapshot', ${{ scripts: ['old.js'] }})
    `
    await db`
      insert into data_row_versions (id, row_id, version_number, cells_json, slug, site_snapshot_id)
      values ('v2', 'page', 2, ${{ title: 'Live title', slug: 'index' }}, 'index', 'snapshot')
    `
    await db`
      insert into data_row_versions (id, row_id, version_number, cells_json, slug, site_snapshot_id)
      values ('template-v1', 'template', 1, ${{ title: 'Shell', slug: 'shell' }}, 'shell', 'snapshot')
    `
    await db`update data_rows set status = 'published', active_version_id = 'v2', published_at = '2026-01-01T00:00:00.000Z' where id = 'page'`
    await db`update data_rows set status = 'scheduled', scheduled_publish_at = '2026-12-01T10:00:00.000Z' where id = 'post'`

    await runMigrations(db, sqliteMigrations)
    expect(await getDefaultLocale(db)).toEqual({ id: 'default', code: 'ar', name: 'ar', pathPrefix: '', isDefault: true, enabled: true, direction: 'rtl' })
    const page = await getContentLocalization(db, 'page', 'default')
    expect(page?.cells).toEqual({ title: 'Draft title', slug: 'draft-page' })
    expect(page?.availability).toBe('online')
    expect(page?.activeVersionId).toBe('v2')
    const { rows: originalRows } = await db<{ cells_json: Record<string, unknown> }>`select cells_json from data_rows where id = 'page'`
    expect(originalRows[0].cells_json.body).toEqual(tree)
    const { rows: versions } = await db<{ id: string; locale_id: string; cells_json: unknown; public_path: string; site_snapshot_id: string; runtime_assets_json: unknown }>`select * from data_row_versions where row_id = 'page' order by version_number`
    expect(versions.map((v) => [v.id, v.locale_id, v.public_path])).toEqual([['v1', 'default', '/old'], ['v2', 'default', '/']])
    expect(versions[0].cells_json).toEqual({ title: 'Old title', slug: 'old' })
    expect(versions[0].runtime_assets_json).toEqual({ scripts: ['old.js'] })
    expect(versions[1].site_snapshot_id).toBe('snapshot')
    const { rows: snapshots } = await db<{ site_json: unknown }>`select site_json from site_snapshots where id = 'snapshot'`
    expect(snapshots[0].site_json).toEqual(site)
    const published = await getPublishedPageSnapshotById(db, 'page')
    expect(published?.versionId).toBe('v2')
    expect(published?.site.pages.find((entry) => entry.id === 'page')?.nodes.root.props.text).toBe('Published body')
    expect((await loadPublishedRouteInventory(db)).routes.map((route) => [route.contentId, route.localeId, route.path])).toEqual([['page', 'default', '/']])
    const { rows: templates } = await db<{ public_path: string | null }>`select public_path from data_row_versions where id = 'template-v1'`
    expect(templates[0].public_path).toBeNull()
    const post = await getContentLocalization(db, 'post', 'default')
    expect(post?.availability).toBe('offline')
    expect(post?.scheduledRevision).toEqual({ cells: { title: 'Scheduled title', body: '# Keep Markdown' }, slug: 'post' })
    expect(await getTableLocalization(db, 'posts', 'default')).toEqual({ tableId: 'posts', localeId: 'default', routeBase: '/posts' })
    const { rows: tables } = await db<{ fields_json: Array<{ id: string; localization?: string }> }>`select fields_json from data_tables where id = 'pages'`
    expect(tables[0].fields_json.find((field) => field.id === 'templateTarget')?.localization).toBe('shared')
    expect(tables[0].fields_json.find((field) => field.id === 'title')?.localization).toBeUndefined()
    await runMigrations(db, sqliteMigrations)
    expect((await listLocales(db)).length).toBe(1)
  })
})

describe('locale registry', () => {
  it('canonicalizes languages and rejects duplicate or reserved route prefixes', async () => {
    const db = await database()
    expect((await getDefaultLocale(db)).code).toBe('en')
    const locale = await createLocale(db, { code: 'de-de', name: ' Deutsch ', pathPrefix: 'DE', enabled: false, direction: 'ltr' })
    expect(locale).toMatchObject({ code: 'de-DE', name: 'Deutsch', pathPrefix: 'de', enabled: false })
    expect(await listContentLocalizations(db, { localeId: locale.id })).toEqual([])
    await expect(createLocale(db, { ...locale, code: 'de-DE', pathPrefix: 'german' })).rejects.toBeInstanceOf(LocalizationError)
    await expect(createLocale(db, { ...locale, code: 'fr', pathPrefix: 'de' })).rejects.toBeInstanceOf(LocalizationError)
    await expect(createLocale(db, { ...locale, code: 'fr', pathPrefix: 'admin' })).rejects.toBeInstanceOf(LocalizationError)
    await expect(createLocale(db, { ...locale, code: 'not_a_locale', pathPrefix: 'bad' })).rejects.toBeInstanceOf(LocalizationError)
    await expect(updateLocale(db, 'default', { pathPrefix: 'en' })).rejects.toBeInstanceOf(LocalizationError)
    expect((await updateLocale(db, locale.id, { enabled: true }))?.enabled).toBe(true)
  })
})

describe('independent content variants', () => {
  it('keeps primary and secondary drafts and live snapshots independent, including scheduling', async () => {
    const db = await database()
    await seedRow(db, 'post')
    const de = await secondLocale(db)
    await saveContentLocalizationDraft(db, 'post', 'default', { cells: { title: 'English' }, slug: 'english' })
    await saveContentLocalizationDraft(db, 'post', de.id, { cells: { title: 'Deutsch' }, slug: 'deutsch' })
    expect((await getContentLocalization(db, 'post', de.id))?.availability).toBe('offline')
    expect(await setContentLocalizationAvailability(db, 'post', de.id, 'online')).toBeNull()
    await seedVersion(db, 'post', 'en-v1', 'default', 1)
    await seedVersion(db, 'post', 'de-v2', de.id, 2)
    expect(await setContentLocalizationPublishedVersion(db, 'post', de.id, 'en-v1')).toBeNull()
    await setContentLocalizationPublishedVersion(db, 'post', de.id, 'de-v2')
    expect((await getContentLocalization(db, 'post', 'default'))?.availability).toBe('offline')
    const when = '2026-12-01T10:00:00.000Z'
    await scheduleContentLocalizationPublish(db, 'post', de.id, when, { cells: { title: 'Frozen scheduled update' }, slug: 'scheduled' })
    await saveContentLocalizationDraft(db, 'post', de.id, { cells: { title: 'Later draft' }, slug: 'later' })
    const scheduled = await getContentLocalization(db, 'post', de.id)
    expect(scheduled?.availability).toBe('online')
    expect(scheduled?.activeVersionId).toBe('de-v2')
    expect(scheduled?.scheduledRevision?.cells).toEqual({ title: 'Frozen scheduled update' })
    expect(await listDueContentLocalizationSchedules(db, '2026-11-01T00:00:00.000Z')).toEqual([])
    expect((await listDueContentLocalizationSchedules(db, when)).map((variant) => variant.localeId)).toEqual([de.id])
    await cancelContentLocalizationSchedule(db, 'post', de.id)
    expect((await getContentLocalization(db, 'post', de.id))?.availability).toBe('online')
    await setContentLocalizationAvailability(db, 'post', de.id, 'offline')
    expect((await getContentLocalization(db, 'post', de.id))?.activeVersionId).toBe('de-v2')
    expect((await getContentLocalization(db, 'post', de.id))?.availability).toBe('offline')
    const { rows } = await db<{ cells_json: unknown }>`select cells_json from data_row_versions where id = 'de-v2'`
    expect(rows[0].cells_json).toEqual({ title: 'Live snapshot', slug: 'live' })
  })

  it('preserves explicit empty overrides and metadata, filters logical deletion, and supports localized collection routes', async () => {
    const db = await database()
    await seedRow(db, 'first')
    await seedRow(db, 'second')
    const de = await secondLocale(db)
    const metadata = { title: { sourceFingerprint: 'source-v1', reviewState: 'reviewed' as const } }
    await saveContentLocalizationDraft(db, 'first', de.id, { cells: { title: '', featuredMedia: null }, slug: 'first', translationMeta: metadata })
    await saveContentLocalizationDraft(db, 'first', de.id, { cells: { title: '' }, slug: 'first' })
    await saveContentLocalizationDraft(db, 'second', de.id, { cells: {}, slug: 'second' })
    expect((await getContentLocalization(db, 'first', de.id))?.translationMeta).toEqual(metadata)
    expect((await getContentLocalization(db, 'first', de.id))?.cells).toEqual({ title: '' })
    expect((await listContentLocalizations(db, { rowIds: ['first'], localeId: de.id, tableId: 'posts' })).length).toBe(1)
    expect(await saveContentLocalizationDraft(db, 'missing', de.id, { cells: {}, slug: 'missing' })).toBeNull()
    expect(await saveContentLocalizationDraft(db, 'first', 'missing', { cells: {}, slug: 'missing' })).toBeNull()
    await db`update data_rows set deleted_at = current_timestamp where id = 'first'`
    expect(await getContentLocalization(db, 'first', de.id)).toBeNull()
    expect((await listContentLocalizations(db, { tableId: 'posts', localeId: de.id })).map((variant) => variant.rowId)).toEqual(['second'])
    expect(await getTableLocalization(db, 'posts', de.id)).toBeNull()
    expect(await saveTableLocalization(db, 'posts', de.id, '/artikel/')).toEqual({ tableId: 'posts', localeId: de.id, routeBase: '/artikel' })
    expect((await getTableLocalization(db, 'posts', 'default'))?.routeBase).toBe('/posts')
  })

  it('allows deleting a logical row with published history without dangling variant references', async () => {
    const db = await database()
    await seedRow(db, 'post')
    await saveContentLocalizationDraft(db, 'post', 'default', { cells: {}, slug: 'post' })
    await seedVersion(db, 'post', 'v1', 'default', 1)
    await setContentLocalizationPublishedVersion(db, 'post', 'default', 'v1')
    await db`delete from data_rows where id = 'post'`
    const { rows } = await db`pragma foreign_key_check`
    expect(rows).toEqual([])
  })
})
