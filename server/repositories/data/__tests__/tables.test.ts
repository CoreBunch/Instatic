import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import {
  createDataTable,
  getDataTable,
  insertDataTableIfAbsent,
  listDataTables,
  updateDataTable,
} from '../tables'
import { MAIN_SCOPE } from '../../../branches/scope'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

describe('data_tables.system column', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('is not-null with a false default — a custom table reads system=false', async () => {
    // createDataTable never sets `system`, so it relies on the column default.
    const table = await createDataTable(db, MAIN_SCOPE, {
      name: 'Products',
      slug: 'products',
      kind: 'data',
      singularLabel: 'Product',
      pluralLabel: 'Products',
    })
    expect(table.system).toBe(false)

    const reread = await getDataTable(db, MAIN_SCOPE, table.id)
    expect(reread?.system).toBe(false)
  })

  it('reads system=true for the seeded system tables', async () => {
    for (const id of ['pages', 'posts', 'components', 'layouts']) {
      const table = await getDataTable(db, MAIN_SCOPE, id)
      expect(table).not.toBeNull()
      expect(table?.system).toBe(true)
    }
  })

  it('stores the column as not-null (no null sneaks through)', async () => {
    // Read the raw column straight from SQLite for every row and assert the
    // value is a concrete 0/1, never null.
    const { rows } = await db<{ system: number | null }>`select system from data_tables`
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.system === 0 || row.system === 1).toBe(true)
    }
  })

  it('list and read agree on system flags', async () => {
    const tables = await listDataTables(db, MAIN_SCOPE)
    const systemSlugs = tables.filter((t) => t.system).map((t) => t.slug).sort()
    expect(systemSlugs).toEqual(['components', 'layouts', 'pages', 'posts'])
  })
})

describe('data_tables.route_base persistence', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('preserves an explicitly blank route base on create and read', async () => {
    const table = await createDataTable(db, MAIN_SCOPE, {
      name: 'Fee lines',
      slug: 'fee-lines',
      kind: 'data',
      routeBase: '',
      singularLabel: 'Fee line',
      pluralLabel: 'Fee lines',
    })

    expect(table.routeBase).toBe('')
    expect((await getDataTable(db, MAIN_SCOPE, table.id))?.routeBase).toBe('')

    const { rows } = await db<{ route_base: string }>`
      select route_base from data_tables where id = ${table.id}
    `
    expect(rows[0]?.route_base).toBe('')
  })

  it('uses the slug fallback only when routeBase is omitted', async () => {
    const fallback = await createDataTable(db, MAIN_SCOPE, {
      name: 'Work orders',
      slug: 'work-orders',
      kind: 'data',
      singularLabel: 'Work order',
      pluralLabel: 'Work orders',
    })
    const explicit = await createDataTable(db, MAIN_SCOPE, {
      name: 'Bench notes',
      slug: 'bench-notes',
      kind: 'data',
      routeBase: '  /notes/  ',
      singularLabel: 'Bench note',
      pluralLabel: 'Bench notes',
    })

    expect(fallback.routeBase).toBe('/work-orders')
    expect(explicit.routeBase).toBe('/notes')
  })

  it('preserves an explicitly blank route base on update', async () => {
    const table = await createDataTable(db, MAIN_SCOPE, {
      name: 'Questions',
      slug: 'questions',
      kind: 'data',
      routeBase: '/questions',
      singularLabel: 'Question',
      pluralLabel: 'Questions',
    })

    const updated = await updateDataTable(db, MAIN_SCOPE, table.id, { routeBase: '   ' })

    expect(updated?.routeBase).toBe('')
    expect((await getDataTable(db, MAIN_SCOPE, table.id))?.routeBase).toBe('')
  })

  it('preserves an explicitly blank route base on the import insertion path', async () => {
    const inserted = await insertDataTableIfAbsent(db, MAIN_SCOPE, {
      id: 'imported-custody-stages',
      name: 'Custody stages',
      slug: 'custody-stages',
      kind: 'data',
      routeBase: '',
      singularLabel: 'Custody stage',
      pluralLabel: 'Custody stages',
    })

    expect(inserted).toBe(true)
    expect((await getDataTable(db, MAIN_SCOPE, 'imported-custody-stages'))?.routeBase).toBe('')
  })
})
