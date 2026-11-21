import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { countDataRows, getDataRow, getDataRowMany } from '../read'
import { softDeleteDataRow } from '../mutations'
import { getDataTableBySlug } from '../../tables'
import { MAIN_SCOPE } from '../../../../branches/scope'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

async function seedRow(db: DbClient, id: string): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, created_at, updated_at)
    values (
      ${id}, ${'posts'}, ${{ title: id, slug: id }}, ${id}, ${'draft'},
      ${'2024-01-01T00:00:00.000Z'}, ${'2024-01-01T00:00:00.000Z'}
    )
  `
}

describe('getDataRowMany', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
    await seedRow(db, 'post-1')
    await seedRow(db, 'post-2')
    await seedRow(db, 'post-3')
  })

  it('returns the same hydrated rows as per-id getDataRow, in one query', async () => {
    const many = await getDataRowMany(db, MAIN_SCOPE, ['post-1', 'post-3'])
    const byId = new Map(many.map((row) => [row.id, row]))
    expect(byId.size).toBe(2)
    expect(byId.get('post-1')).toEqual((await getDataRow(db, MAIN_SCOPE, 'post-1')) ?? undefined)
    expect(byId.get('post-3')).toEqual((await getDataRow(db, MAIN_SCOPE, 'post-3')) ?? undefined)
  })

  it('omits missing and soft-deleted ids instead of throwing', async () => {
    await softDeleteDataRow(db, MAIN_SCOPE, 'post-2')
    const many = await getDataRowMany(db, MAIN_SCOPE, ['post-1', 'post-2', 'nope'])
    expect(many.map((row) => row.id)).toEqual(['post-1'])
  })

  it('returns [] for an empty id list without touching the db', async () => {
    expect(await getDataRowMany(db, MAIN_SCOPE, [])).toEqual([])
  })
})

describe('countDataRows', () => {
  it('counts only non-deleted rows in the table', async () => {
    const db = await freshDb()
    await seedRow(db, 'post-1')
    await seedRow(db, 'post-2')
    expect(await countDataRows(db, MAIN_SCOPE, 'posts')).toBe(2)
    await softDeleteDataRow(db, MAIN_SCOPE, 'post-1')
    expect(await countDataRows(db, MAIN_SCOPE, 'posts')).toBe(1)
    expect(await countDataRows(db, MAIN_SCOPE, 'pages')).toBe(0)
  })
})

describe('getDataTableBySlug', () => {
  it('resolves a seeded system table by slug and misses unknown slugs', async () => {
    const db = await freshDb()
    const posts = await getDataTableBySlug(db, MAIN_SCOPE, 'posts')
    expect(posts?.id).toBe('posts')
    expect(posts?.system).toBe(true)
    expect(await getDataTableBySlug(db, MAIN_SCOPE, 'no-such-table')).toBeNull()
  })
})
