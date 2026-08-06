/**
 * Behavior tests for the `data.rows` loop cell filter against a real
 * migrated SQLite database.
 *
 * The pure half (parsing, SQL assembly) is covered in `cellFilter.test.ts`;
 * what matters here is that the condition actually reaches the query on
 * BOTH table kinds, that `totalItems` counts the filtered set (otherwise
 * pagination advertises rows the page query drops), and that a filter on a
 * field some rows lack behaves the way an author expects.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'
import type { CellFilter } from '@core/loops/cellFilter'

type Db = TestDb['db']

let testDb: TestDb
let db: Db

async function seedPost(
  rowId: string,
  slug: string,
  cells: Record<string, unknown>,
  publishedAt: string,
): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, updated_at)
    values (${rowId}, ${'posts'}, ${JSON.stringify(cells)}, ${slug}, ${'published'}, ${publishedAt})
  `
  await db`
    insert into data_row_versions (id, row_id, version_number, cells_json, slug, published_at, created_at)
    values (${`${rowId}-v1`}, ${rowId}, ${1}, ${JSON.stringify(cells)}, ${slug}, ${publishedAt}, ${publishedAt})
  `
  await db`update data_rows set active_version_id = ${`${rowId}-v1`} where id = ${rowId}`
}

async function seedDataRow(
  tableId: string,
  rowId: string,
  slug: string,
  cells: Record<string, unknown>,
): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, created_at, updated_at)
    values (${rowId}, ${tableId}, ${JSON.stringify(cells)}, ${slug}, ${'draft'}, ${'2024-01-01T00:00:00Z'}, ${'2024-01-01T00:00:00Z'})
  `
}

async function slugsWith(tableId: string, cellFilter: CellFilter | null): Promise<string[]> {
  const { items } = await fetchPublishedDataRowItems(db, {
    tableId,
    orderBy: 'slug',
    direction: 'asc',
    limit: 50,
    offset: 0,
    cellFilter,
  })
  return items.map((item) => String(item.fields['slug']))
}

beforeAll(async () => {
  testDb = await createTestDb()
  db = testDb.db

  // Post-type rows: two featured, one not, one missing the field entirely —
  // the exact shape that made a real migration list the wrong three items.
  await seedPost('p-a', 'alpha', { title: 'Alpha', featured: true, tag: 'news' }, '2024-01-01T00:00:00Z')
  await seedPost('p-b', 'bravo', { title: 'Bravo', featured: false, tag: 'news' }, '2024-01-02T00:00:00Z')
  await seedPost('p-c', 'charlie', { title: 'Charlie', featured: true, tag: 'guide' }, '2024-01-03T00:00:00Z')
  await seedPost('p-d', 'delta', { title: 'Delta' }, '2024-01-04T00:00:00Z')

  await db`
    insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label, fields_json, system)
    values ('logos', 'Logos', 'logos', 'data', '/logos', 'Logo', 'Logos', ${JSON.stringify([])}, 0)
  `
  await seedDataRow('logos', 'l-a', 'acme', { name: 'Acme', member: true })
  await seedDataRow('logos', 'l-b', 'globex', { name: 'Globex', member: false })
  await seedDataRow('logos', 'l-c', 'initech', { name: 'Initech' })
})

afterAll(async () => {
  await testDb.cleanup()
})

describe('data.rows cell filter — post-type tables', () => {
  it('no filter lists every published row', async () => {
    expect(await slugsWith('posts', null)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  it('isTrue keeps only the marked rows', async () => {
    expect(await slugsWith('posts', { field: 'featured', operator: 'isTrue', value: '' }))
      .toEqual(['alpha', 'charlie'])
  })

  it('isFalse includes rows that lack the field', async () => {
    expect(await slugsWith('posts', { field: 'featured', operator: 'isFalse', value: '' }))
      .toEqual(['bravo', 'delta'])
  })

  it('is matches a text cell exactly', async () => {
    expect(await slugsWith('posts', { field: 'tag', operator: 'is', value: 'news' }))
      .toEqual(['alpha', 'bravo'])
  })

  it('isNot also returns rows missing the field', async () => {
    expect(await slugsWith('posts', { field: 'tag', operator: 'isNot', value: 'news' }))
      .toEqual(['charlie', 'delta'])
  })

  it('isSet / isEmpty split on presence', async () => {
    expect(await slugsWith('posts', { field: 'tag', operator: 'isSet', value: '' }))
      .toEqual(['alpha', 'bravo', 'charlie'])
    expect(await slugsWith('posts', { field: 'tag', operator: 'isEmpty', value: '' }))
      .toEqual(['delta'])
  })

  it('totalItems counts the filtered set, not the table', async () => {
    const { items, totalItems } = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'slug',
      direction: 'asc',
      limit: 1,
      offset: 0,
      cellFilter: { field: 'featured', operator: 'isTrue', value: '' },
    })
    expect(items).toHaveLength(1)
    expect(totalItems).toBe(2)
  })

  it('paginates within the filtered set', async () => {
    const { items } = await fetchPublishedDataRowItems(db, {
      tableId: 'posts',
      orderBy: 'slug',
      direction: 'asc',
      limit: 5,
      offset: 1,
      cellFilter: { field: 'featured', operator: 'isTrue', value: '' },
    })
    expect(items.map((i) => String(i.fields['slug']))).toEqual(['charlie'])
  })

  it('an unknown field matches nothing rather than everything', async () => {
    expect(await slugsWith('posts', { field: 'nope', operator: 'isTrue', value: '' })).toEqual([])
  })
})

describe('data.rows cell filter — data-kind tables', () => {
  it('applies on the direct-read path too', async () => {
    expect(await slugsWith('logos', { field: 'member', operator: 'isTrue', value: '' })).toEqual(['acme'])
  })

  it('counts the filtered set on the data-kind path', async () => {
    const { totalItems } = await fetchPublishedDataRowItems(db, {
      tableId: 'logos',
      orderBy: 'slug',
      direction: 'asc',
      limit: 50,
      offset: 0,
      cellFilter: { field: 'member', operator: 'isFalse', value: '' },
    })
    expect(totalItems).toBe(2)
  })
})
