import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { listDataRowsWithFilter } from '../filter'
import { MAIN_SCOPE } from '../../../../branches/scope'

/**
 * Wrap a DbClient so every `db.unsafe()` call is counted. The hydrated SELECT
 * and the dynamic filter both run through `db.unsafe()`, so the counter is a
 * faithful proxy for "round-trips to hydrate a filtered page".
 */
function countingDb(inner: DbClient): { db: DbClient; counts: { unsafe: number } } {
  const counts = { unsafe: 0 }
  const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    inner(strings, ...values)) as DbClient
  wrapped.unsafe = (sql: string, params?: unknown[]) => {
    counts.unsafe++
    return inner.unsafe(sql, params)
  }
  wrapped.transaction = (cb) => inner.transaction(cb)
  return { db: Object.assign(wrapped, { dialect: inner.dialect }), counts }
}

const USER_ID = 'user-author'

async function seedUser(db: DbClient): Promise<void> {
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
    values (${USER_ID}, ${'author@example.com'}, ${'author@example.com'}, ${'Author Person'}, ${'x'}, ${'active'}, ${'owner'})
  `
}

interface SeedRow {
  id: string
  title: string
  status: 'draft' | 'published' | 'unpublished'
  updatedAt: string
  deleted?: boolean
}

async function seedRow(db: DbClient, row: SeedRow): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, author_user_id, created_at, updated_at, deleted_at)
    values (
      ${row.id},
      ${'posts'},
      ${{ title: row.title, slug: row.id }},
      ${row.id},
      ${row.status},
      ${USER_ID},
      ${row.updatedAt},
      ${row.updatedAt},
      ${row.deleted ? '2024-12-31T00:00:00.000Z' : null}
    )
  `
}

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await seedUser(db)
  return db
}

describe('listDataRowsWithFilter', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
    // Four live rows + one soft-deleted row. updated_at controls default order.
    await seedRow(db, { id: 'alpha', title: 'Alpha', status: 'published', updatedAt: '2024-01-01T00:00:00.000Z' })
    await seedRow(db, { id: 'beta', title: 'Beta', status: 'draft', updatedAt: '2024-02-01T00:00:00.000Z' })
    await seedRow(db, { id: 'gamma', title: 'Gamma', status: 'published', updatedAt: '2024-03-01T00:00:00.000Z' })
    await seedRow(db, { id: 'deleted', title: 'Deleted', status: 'published', updatedAt: '2024-05-01T00:00:00.000Z', deleted: true })
    await seedRow(db, { id: 'delta', title: 'Delta', status: 'published', updatedAt: '2024-04-01T00:00:00.000Z' })
  })

  it('returns live rows in default updated_at-desc order, excluding soft-deleted', async () => {
    const { rows, totalCount } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts')
    expect(rows.map((r) => r.id)).toEqual(['delta', 'gamma', 'beta', 'alpha'])
    expect(totalCount).toBe(4)
  })

  it('hydrates the author user reference', async () => {
    const { rows } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts', { filter: { title: 'Alpha' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('alpha')
    expect(rows[0].authorUserId).toBe(USER_ID)
    expect(rows[0].author?.displayName).toBe('Author Person')
    expect(rows[0].author?.email).toBe('author@example.com')
    expect(rows[0].cells.title).toBe('Alpha')
  })

  it('paginates with limit + offset while preserving order', async () => {
    const { rows, totalCount } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts', { limit: 2, offset: 1 })
    expect(rows.map((r) => r.id)).toEqual(['gamma', 'beta'])
    expect(totalCount).toBe(4)
  })

  it('filters by status', async () => {
    const { rows, totalCount } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts', { status: 'published' })
    expect(rows.map((r) => r.id)).toEqual(['delta', 'gamma', 'alpha'])
    expect(totalCount).toBe(3)
  })

  it('filters by a cells_json field (where condition)', async () => {
    const { rows, totalCount } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts', { filter: { title: 'Gamma' } })
    expect(rows.map((r) => r.id)).toEqual(['gamma'])
    expect(totalCount).toBe(1)
  })

  it('returns an empty result set without error', async () => {
    const { rows, totalCount } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts', { filter: { title: 'Nonexistent' } })
    expect(rows).toEqual([])
    expect(totalCount).toBe(0)
  })

  it('honors custom orderBy on row-level columns', async () => {
    const { rows } = await listDataRowsWithFilter(db, MAIN_SCOPE, 'posts', { orderBy: { created_at: 'asc' } })
    expect(rows.map((r) => r.id)).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('issues a bounded number of queries that does NOT scale with row count', async () => {
    // Small dataset.
    const small = countingDb(db)
    const smallResult = await listDataRowsWithFilter(small.db, MAIN_SCOPE, 'posts', { limit: 500 })
    expect(smallResult.rows).toHaveLength(4)

    // Large dataset — many more matching rows.
    const bigDb = await freshDb()
    for (let i = 0; i < 50; i++) {
      await seedRow(bigDb, {
        id: `row-${i}`,
        title: `Row ${i}`,
        status: 'published',
        updatedAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
    }
    const big = countingDb(bigDb)
    const bigResult = await listDataRowsWithFilter(big.db, MAIN_SCOPE, 'posts', { limit: 500 })
    expect(bigResult.rows).toHaveLength(50)

    // Two queries total: one hydrated data page + one count. Crucially the
    // count is identical for 4 rows and 50 rows — no per-row hydration.
    expect(small.counts.unsafe).toBe(2)
    expect(big.counts.unsafe).toBe(2)
    expect(big.counts.unsafe).toBe(small.counts.unsafe)
  })
})
