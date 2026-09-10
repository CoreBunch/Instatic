import { expect, test } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { createDataRow, createDataTable, saveDataRowDraft, updateDataTable, getDataRow } from '../../../server/repositories/data'
import { createLocale, saveContentLocalizationDraft, setContentLocalizationPublishedVersion, setContentLocalizationAvailability } from '../../../server/repositories/localization'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'

test('a published translation stays in its list after the source is withdrawn and draft paths change', async () => {
  const { db, cleanup } = await createTestDb()
  try {
    const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
    const row = await createDataRow(db, { tableId: 'posts', cells: { title: 'English', slug: 'english' }, slug: 'english' })
    await saveContentLocalizationDraft(db, row.id, locale.id, { cells: { title: 'Deutsch', slug: 'deutsch' }, slug: 'deutsch' })
    await db`insert into data_row_versions (id, row_id, locale_id, public_path, version_number, cells_json, slug)
      values ('german-release', ${row.id}, ${locale.id}, '/de/beitraege/deutsch', 1, ${{ title: 'Veröffentlicht' }}, 'deutsch')`
    await setContentLocalizationPublishedVersion(db, row.id, locale.id, 'german-release')
    await setContentLocalizationAvailability(db, row.id, 'default', 'offline')
    await saveDataRowDraft(db, row.id, { localeId: locale.id, cells: { title: 'Unpublished draft', slug: 'new-path' }, slug: 'new-path' })
    const result = await fetchPublishedDataRowItems(db, { localeId: locale.id, tableId: 'posts', orderBy: 'slug', direction: 'asc', limit: 1, offset: 0 })
    expect(result.totalItems).toBe(1)
    expect(result.items[0]?.fields.title).toBe('Veröffentlicht')
    expect(result.items[0]?.fields.permalink).toBe('/de/beitraege/deutsch')
    const source = await fetchPublishedDataRowItems(db, { localeId: 'default', tableId: 'posts', orderBy: 'slug', direction: 'asc', limit: 1, offset: 0 })
    expect(source).toEqual({ items: [], totalItems: 0 })
    await setContentLocalizationAvailability(db, row.id, locale.id, 'offline')
    const withdrawn = await fetchPublishedDataRowItems(db, { localeId: locale.id, tableId: 'posts', orderBy: 'slug', direction: 'asc', limit: 1, offset: 0 })
    expect(withdrawn).toEqual({ items: [], totalItems: 0 })
  } finally { await cleanup() }
})

test('localized data fields resolve explicit null before filtering, counting and pagination', async () => {
  const { db, cleanup } = await createTestDb()
  try {
    const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
    const table = await createDataTable(db, { name: 'Logos', slug: 'logos', kind: 'data', singularLabel: 'Logo', pluralLabel: 'Logos', fields: [
      { id: 'title', label: 'Title', type: 'text', localization: 'localized' },
      { id: 'rank', label: 'Rank', type: 'number', localization: 'shared' },
    ] })
    const row = await createDataRow(db, { tableId: table.id, cells: { title: 'Source', rank: 3 }, slug: 'logo' })
    await saveDataRowDraft(db, row.id, { localeId: locale.id, cells: { title: null, rank: 3 }, slug: 'logo' })
    const result = await fetchPublishedDataRowItems(db, {
      localeId: locale.id, tableId: table.id, orderBy: 'cell:rank', direction: 'asc', limit: 1, offset: 0,
      cellFilter: { field: 'title', operator: 'isEmpty', value: '' },
    })
    expect(result.totalItems).toBe(1)
    expect(result.items[0]?.fields.title).toBeNull()
    expect(result.items[0]?.fields.rank).toBe(3)
  } finally { await cleanup() }
})

test('changing a field between shared and translated preserves the source and existing translations', async () => {
  const { db, cleanup } = await createTestDb()
  try {
    const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', enabled: true, direction: 'ltr' })
    const table = await createDataTable(db, { name: 'Details', slug: 'details', kind: 'data', singularLabel: 'Detail', pluralLabel: 'Details', fields: [
      { id: 'name', label: 'Name', type: 'text', localization: 'shared' },
    ] })
    const row = await createDataRow(db, { tableId: table.id, cells: { name: 'Source name' }, slug: '' })
    await updateDataTable(db, table.id, { fields: [{ id: 'name', label: 'Name', type: 'text', localization: 'localized' }] })
    expect((await getDataRow(db, row.id, locale.id))?.cells.name).toBe('Source name')
    await saveDataRowDraft(db, row.id, { localeId: locale.id, cells: { name: 'Übersetzt' }, slug: '' })
    await updateDataTable(db, table.id, { fields: [{ id: 'name', label: 'Name', type: 'text', localization: 'shared' }] })
    expect((await getDataRow(db, row.id, locale.id))?.cells.name).toBe('Source name')
    await updateDataTable(db, table.id, { fields: [{ id: 'name', label: 'Name', type: 'text', localization: 'localized' }] })
    expect((await getDataRow(db, row.id, locale.id))?.cells.name).toBe('Übersetzt')
  } finally { await cleanup() }
})
