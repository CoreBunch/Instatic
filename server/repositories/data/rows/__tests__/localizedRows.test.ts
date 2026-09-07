import { createDataTable, getDataTable, updateDataTable } from '../../tables'
import { withPublishLock } from '../../../../publish/publishState'
import { afterEach, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { createDataRow, saveDataRowDraft, softDeleteDataRow, updateDataRowStatus, updateDataRowTable, updateDataRowAuthor, upsertSharedDataRowDraft } from '../mutations'
import { getDataRow, getDataRowBySlug, getDataRowMany, listDataRows } from '../read'
import { searchDataRows } from '../search'
import { createTranslationFieldMetadata, getTranslationFieldState } from '@core/localization'
import { listDataRowsWithFilter } from '../filter'
import { scheduleDataRowPublish, cancelScheduledPublish, listDuePublishSchedules } from '../schedule'
import { createLocale, getContentLocalization, LocalizationError, saveContentLocalizationDraft, setContentLocalizationPublishedVersion } from '../../../localization'
import { insertDataRowIfAbsent, upsertDataRow } from '../import'

const clients: DbClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((db) => db.close())) })

async function fixture() {
  const db = createSqliteClient(':memory:')
  clients.push(db)
  await runMigrations(db, sqliteMigrations)
  const de = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
  const first = await createDataRow(db, { tableId: 'posts', cells: { title: 'Alpha', body: 'Original', slug: 'alpha' }, slug: 'alpha' })
  const second = await createDataRow(db, { tableId: 'posts', cells: { title: 'Bravo', body: 'Second', slug: 'bravo' }, slug: 'bravo' })
  return { db, de, first, second }
}

describe('localized row integration', () => {
  it('uses one draft slug in sparse writes, projections, filters and lookups', async () => {
    const { db, de, first } = await fixture()
    await saveContentLocalizationDraft(db, first.id, de.id, { cells: { title: 'Deutsch' }, slug: 'deutsch' })
    const sparse = await getDataRow(db, first.id, de.id)
    expect(sparse?.slug).toBe('deutsch')
    expect(sparse?.cells.slug).toBe('deutsch')
    expect(Object.hasOwn(sparse!.localization!.cells, 'slug')).toBe(false)
    expect((await listDataRowsWithFilter(db, 'posts', { localeId: de.id, filter: { slug: 'deutsch' } })).rows.map((row) => row.id)).toEqual([first.id])
    expect((await getDataRowBySlug(db, 'posts', 'deutsch', de.id))?.cells.slug).toBe('deutsch')
    await saveContentLocalizationDraft(db, first.id, de.id, { cells: { title: 'Deutsch', slug: 'conflicting-cell' }, slug: 'canonical' })
    expect((await getContentLocalization(db, first.id, de.id))?.cells.slug).toBe('canonical')
    const saved = await saveDataRowDraft(db, first.id, { cells: { ...sparse!.cells, slug: 'stale-cell' }, slug: 'next-canonical', localeId: de.id })
    expect(saved?.cells.slug).toBe('next-canonical')
    expect(saved?.localization?.cells.slug).toBe('next-canonical')
    expect((await getDataRow(db, first.id))?.cells.slug).toBe('alpha')
  })

  it('keeps public routing slugs localized while structural identifiers stay shared', async () => {
    const { db } = await fixture()
    const posts = await getDataTable(db, 'posts')
    expect(posts?.fields.find((field) => field.id === 'slug')?.localization).toBe('localized')
    await expect(updateDataTable(db, 'posts', { fields: posts!.fields.map((field) => field.id === 'slug' ? { ...field, localization: 'shared' } : field) })).rejects.toBeInstanceOf(LocalizationError)
    await expect(createDataTable(db, { name: 'Invalid', slug: 'invalid', kind: 'postType', singularLabel: 'Invalid', pluralLabel: 'Invalid', fields: [{ id: 'slug', label: 'Slug', type: 'text', localization: 'shared' }] })).rejects.toBeInstanceOf(LocalizationError)
    for (const tableId of ['components', 'layouts']) expect((await getDataTable(db, tableId))?.fields.find((field) => field.id === 'slug')?.localization).toBe('shared')
  })

  it('preserves a locale slug when a draft update only supplies cells', async () => {
    const { db, de, first } = await fixture()
    await saveDataRowDraft(db, first.id, { cells: { ...first.cells, slug: 'hallo' }, localeId: de.id })
    const updated = await saveDataRowDraft(db, first.id, { cells: { title: 'Hallo' }, localeId: de.id })
    expect(updated?.slug).toBe('hallo')
    expect((await getDataRow(db, first.id))?.slug).toBe('alpha')
  })

  it('rejects explicit unknown selections even with no matching rows and before author writes', async () => {
    const { db, first } = await fixture()
    for (const localeId of ['', 'missing']) {
      await expect(getDataRow(db, 'absent', localeId)).rejects.toBeInstanceOf(LocalizationError)
      await expect(getDataRowMany(db, [], localeId)).rejects.toBeInstanceOf(LocalizationError)
      await expect(getDataRowBySlug(db, 'posts', 'absent', localeId)).rejects.toBeInstanceOf(LocalizationError)
      await expect(listDataRows(db, 'empty-table', { localeId })).rejects.toBeInstanceOf(LocalizationError)
      await expect(listDataRowsWithFilter(db, 'posts', { localeId })).rejects.toBeInstanceOf(LocalizationError)
      await expect(searchDataRows(db, 'absent', 1, { localeId })).rejects.toBeInstanceOf(LocalizationError)
      await expect(updateDataRowAuthor(db, first.id, 'unvalidated-author', null, localeId)).rejects.toBeInstanceOf(LocalizationError)
    }
    expect((await getDataRow(db, first.id))?.authorUserId).toBeNull()
    expect(await getContentLocalization(db, first.id, '')).toBeNull()
  })

  it('invalidates review of edited translations and preserves untouched field reviews', async () => {
    const { db, first, de } = await fixture()
    const titleMeta = createTranslationFieldMetadata(first.cells.title, 'reviewed')
    const bodyMeta = createTranslationFieldMetadata(first.cells.body, 'reviewed')
    await saveContentLocalizationDraft(db, first.id, de.id, {
      cells: { title: 'Deutsch', body: 'Original übersetzt' }, slug: 'deutsch',
      translationMeta: { title: titleMeta, body: bodyMeta },
    })
    const previous = await getDataRow(db, first.id, de.id)
    const saved = await saveDataRowDraft(db, first.id, { cells: { ...previous?.cells, title: 'Neue Übersetzung' }, localeId: de.id })
    expect(saved?.localization?.translationMeta.title.reviewState).toBe('needs_review')
    expect(saved?.localization?.translationMeta.body).toEqual(bodyMeta)
    expect(getTranslationFieldState(first.cells, saved!.localization!.cells, 'title', saved?.localization?.translationMeta.title)).toBe('needs_review')
  })

  it('preserves source values and dormant translations when collection field modes differ', async () => {
    const { db, de } = await fixture()
    for (const [id, shared] of [['from-data', false], ['to-data', true]] as const) {
      await createDataTable(db, { id, name: id, slug: id, kind: 'data', singularLabel: 'Row', pluralLabel: 'Rows', fields: [
        { id: 'title', label: 'Title', type: 'text', localization: shared ? 'shared' : 'localized' },
        { id: 'note', label: 'Note', type: 'text', localization: shared ? 'localized' : 'shared' },
      ] })
    }
    const row = await createDataRow(db, { tableId: 'from-data', cells: { title: 'Source', note: 'Shared note' }, slug: '' })
    await saveDataRowDraft(db, row.id, { cells: { title: 'Deutsch', note: 'Shared note' }, slug: '', localeId: de.id })
    const moved = await updateDataRowTable(db, row.id, 'to-data', null, { localeId: de.id })
    expect(moved.ok && moved.row.cells).toMatchObject({ title: 'Source', note: 'Shared note' })
    expect((await getDataRow(db, row.id))?.cells).toMatchObject({ title: 'Source', note: 'Shared note' })
    expect((await getContentLocalization(db, row.id, de.id))?.cells.title).toBe('Deutsch')
    const restored = await updateDataRowTable(db, row.id, 'from-data', null, { localeId: de.id })
    expect(restored.ok && restored.row.cells).toMatchObject({ title: 'Deutsch', note: 'Shared note' })
  })

  it('does not move content into shared structural tables', async () => {
    const { db, first, de } = await fixture()
    for (const tableId of ['pages', 'components', 'layouts']) {
      expect(await updateDataRowTable(db, first.id, tableId, null, { localeId: de.id })).toEqual({ ok: false, reason: 'unsupported_table' })
    }
    expect((await getDataRow(db, first.id))?.tableId).toBe('posts')
    expect((await getDataRow(db, first.id))?.cells.title).toBe('Alpha')
  })

  it('waits for an in-flight publication before retracting a language', async () => {
    const { db, de, first } = await fixture()
    await saveDataRowDraft(db, first.id, { cells: { title: 'Deutsch' }, slug: 'deutsch', localeId: de.id })
    await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug) values ('race-version', ${first.id}, ${de.id}, 1, ${{ title: 'Live' }}, 'live')`
    await setContentLocalizationPublishedVersion(db, first.id, de.id, 'race-version')
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const publishing = withPublishLock(async () => { entered(); await gate })
    await started
    const retracting = updateDataRowStatus(db, first.id, 'unpublished', null, de.id)
    try {
      await Bun.sleep(5)
      expect((await getContentLocalization(db, first.id, de.id))?.availability).toBe('online')
    } finally {
      release()
      await publishing
    }
    expect((await retracting)?.status).toBe('unpublished')
    expect((await getContentLocalization(db, first.id, de.id))?.availability).toBe('offline')
  })

  it('retracts every language and cancels frozen schedules when content moves collections', async () => {
    const { db, de, first } = await fixture()
    await createDataTable(db, { id: 'articles', name: 'Articles', slug: 'articles', kind: 'postType', singularLabel: 'Article', pluralLabel: 'Articles' })
    await saveDataRowDraft(db, first.id, { cells: { title: 'Deutsch' }, slug: 'deutsch', localeId: de.id })
    await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug) values ('move-source', ${first.id}, 'default', 1, ${{ title: 'Source' }}, 'source')`
    await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug) values ('move-de', ${first.id}, ${de.id}, 2, ${{ title: 'Deutsch' }}, 'deutsch')`
    await setContentLocalizationPublishedVersion(db, first.id, 'default', 'move-source')
    await setContentLocalizationPublishedVersion(db, first.id, de.id, 'move-de')
    await scheduleDataRowPublish(db, first.id, '2026-12-01T00:00:00.000Z', null, de.id)
    const moved = await updateDataRowTable(db, first.id, 'articles', null, { localeId: de.id })
    expect(moved.ok).toBe(true)
    for (const localeId of ['default', de.id]) {
      const variant = await getContentLocalization(db, first.id, localeId)
      expect(variant?.availability).toBe('offline')
      expect(variant?.scheduledPublishAt).toBeNull()
      expect(variant?.activeVersionId).not.toBeNull()
    }
  })

  it('stores sparse translations, keeps inherited fields linked, and resolves slugs by language', async () => {
    const { db, de, first } = await fixture()
    const inherited = await getDataRow(db, first.id, de.id)
    expect(inherited?.cells.title).toBe('Alpha')
    expect(inherited?.localization).toBeNull()
    await saveDataRowDraft(db, first.id, { cells: { ...inherited?.cells, title: 'Deutsch', slug: 'deutsch' }, slug: 'deutsch', localeId: de.id })
    expect((await getContentLocalization(db, first.id, de.id))?.cells).toEqual({ title: 'Deutsch', slug: 'deutsch' })
    await saveDataRowDraft(db, first.id, { cells: { ...first.cells, body: 'Changed source' }, slug: first.slug })
    const translated = await getDataRow(db, first.id, de.id)
    expect(translated?.cells).toMatchObject({ title: 'Deutsch', body: 'Changed source' })
    expect((await getDataRowBySlug(db, 'posts', 'deutsch', de.id))?.id).toBe(first.id)
    expect(await getDataRowBySlug(db, 'posts', 'deutsch', 'default')).toBeNull()
    expect((await getDataRow(db, first.id))?.cells.title).toBe('Alpha')
  })

  it('filters resolved values before pagination and honors null overrides over source values', async () => {
    const { db, de, first, second } = await fixture()
    await saveDataRowDraft(db, first.id, { cells: { ...first.cells, title: null }, slug: first.slug, localeId: de.id })
    await saveDataRowDraft(db, second.id, { cells: { ...second.cells, title: 'Aardvark' }, slug: second.slug, localeId: de.id })
    const filtered = await listDataRowsWithFilter(db, 'posts', { localeId: de.id, filter: { title: { like: 'A%' } }, orderBy: { title: 'asc' }, limit: 1 })
    expect(filtered.totalCount).toBe(1)
    expect(filtered.rows[0].id).toBe(second.id)
    expect((await listDataRowsWithFilter(db, 'posts', { localeId: de.id, filter: { title: null } })).rows.map((row) => row.id)).toEqual([first.id])
    expect((await listDataRowsWithFilter(db, 'posts', { filter: { title: 'Alpha' } })).totalCount).toBe(1)
    expect((await listDataRowsWithFilter(db, 'posts', { localeId: de.id, filter: { title: { eq: null } } })).rows.map((row) => row.id)).toEqual([first.id])
    expect((await listDataRowsWithFilter(db, 'posts', { localeId: de.id, filter: { title: { ne: null } } })).rows.map((row) => row.id)).toEqual([second.id])
  })

  it('keeps a published translation online while scheduling a frozen update and editing later drafts', async () => {
    const { db, de, first } = await fixture()
    await saveDataRowDraft(db, first.id, { cells: { ...first.cells, title: 'Deutsch' }, slug: 'deutsch', localeId: de.id })
    await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug, public_path) values ('de-version', ${first.id}, ${de.id}, 1, ${{ title: 'Live' }}, 'live', '/de/posts/live')`
    await setContentLocalizationPublishedVersion(db, first.id, de.id, 'de-version')
    const scheduled = await scheduleDataRowPublish(db, first.id, '2026-12-01T12:00:00.000Z', null, de.id)
    expect(scheduled?.status).toBe('published')
    expect(scheduled?.publicPath).toBe('/de/posts/live')
    await saveDataRowDraft(db, first.id, { cells: { ...scheduled?.cells, title: 'Later draft' }, slug: 'later', localeId: de.id })
    const due = await listDuePublishSchedules(db, '2026-12-02T00:00:00.000Z', 10)
    expect(due).toHaveLength(1)
    expect(due[0].localeId).toBe(de.id)
    expect(due[0].scheduledRevision.cells.title).toBe('Deutsch')
    expect((await cancelScheduledPublish(db, first.id, null, de.id))?.status).toBe('published')
    expect((await getDataRow(db, first.id))?.status).toBe('draft')
    expect((await softDeleteDataRow(db, first.id))?.status).toBe('published')
  })

  it('keeps logical shared writes separate from locale values and rejects cross-table identity reuse', async () => {
    const { db, first } = await fixture()
    await upsertSharedDataRowDraft(db, { id: first.id, tableId: 'posts', cells: { structural: 'new' } })
    expect((await getDataRow(db, first.id))?.cells).toMatchObject({ title: 'Alpha', structural: 'new' })
    await expect(upsertSharedDataRowDraft(db, { id: first.id, tableId: 'pages', cells: {} })).rejects.toThrow('another collection')
    expect((await getDataRow(db, first.id))?.tableId).toBe('posts')
  })

  it('restores imports as drafts unless a matching published snapshot exists', async () => {
    const { db, first } = await fixture()
    const input = { id: 'imported', tableId: 'posts', cells: { title: 'Imported' }, slug: 'imported', status: 'published' as const, publishedAt: null, createdAt: null, updatedAt: null }
    await upsertDataRow(db, input)
    expect((await getDataRow(db, input.id))?.status).toBe('draft')
    expect((await getDataRow(db, input.id))?.cells.title).toBe('Imported')
    expect(await insertDataRowIfAbsent(db, { ...input, id: 'duplicate', slug: first.slug })).toBe(false)
    expect(await getDataRow(db, 'duplicate')).toBeNull()
  })
})
