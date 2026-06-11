/**
 * Migration 017 (layouts system table) — in-place upgrade of an EXISTING
 * database. Installs are live; nobody re-creates their DB for a new feature,
 * so 017 must:
 *
 *   1. Widen the data_tables.kind enum to accept 'layout' (SQLite: full table
 *      rebuild with deferred FKs — the dance from migration 012).
 *   2. Seed the locked 'layouts' system table.
 *   3. Leave every pre-existing table and row untouched, with data_rows FK
 *      references intact.
 */

import { beforeAll, describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../sqlite'
import { runMigrations } from '../runMigrations'
import { sqliteMigrations } from '../migrations-sqlite'
import {
  createDataTable,
  listDataTables,
} from '../../repositories/data/tables'
import { createDataRow, listDataRows } from '../../repositories/data/rows'
import type { DbClient } from '../client'

let db: DbClient

beforeAll(async () => {
  db = createSqliteClient(':memory:')

  // 1. Boot a "pre-layouts" database: everything up to (excluding) 017.
  const before017 = sqliteMigrations.filter((m) => m.id !== '017_layouts_system_table')
  expect(before017.length).toBe(sqliteMigrations.length - 1)
  await runMigrations(db, before017)

  // 2. Populate it like a live install: a custom table plus system rows that
  //    hold FK references into data_tables.
  await createDataTable(db, {
    id: 'faqs',
    name: 'FAQs',
    slug: 'faqs',
    kind: 'data',
    singularLabel: 'FAQ',
    pluralLabel: 'FAQs',
  })
  await createDataRow(db, {
    tableId: 'pages',
    cells: { title: 'Home', slug: 'home', body: { nodes: {}, rootNodeId: 'root' } },
    slug: 'home',
  })
  await createDataRow(db, {
    tableId: 'faqs',
    cells: { title: 'What is this?' },
    slug: 'what-is-this',
  })

  // 3. Upgrade in place — only 017 is pending.
  await runMigrations(db, sqliteMigrations)
})

describe('migration 017 — layouts system table upgrade', () => {
  it('seeds the layouts table as a locked system table', async () => {
    const tables = await listDataTables(db)
    const layouts = tables.find((t) => t.id === 'layouts')
    expect(layouts).toBeDefined()
    expect(layouts!.system).toBe(true)
    expect(layouts!.kind).toBe('layout')
  })

  it('preserves pre-existing tables and rows across the rebuild', async () => {
    const tables = await listDataTables(db)
    expect(tables.map((t) => t.id)).toEqual(
      expect.arrayContaining(['posts', 'pages', 'components', 'layouts', 'faqs']),
    )

    const pageRows = await listDataRows(db, 'pages')
    expect(pageRows.map((r) => r.slug)).toEqual(['home'])
    const faqRows = await listDataRows(db, 'faqs')
    expect(faqRows.map((r) => r.slug)).toEqual(['what-is-this'])
  })

  it('accepts layout rows after the upgrade (FK into the rebuilt table)', async () => {
    const row = await createDataRow(db, {
      tableId: 'layouts',
      cells: {
        name: 'Hero',
        slug: 'hero',
        body: { nodes: { root: { id: 'root', moduleId: 'base.container', props: {}, breakpointOverrides: {}, children: [], classIds: [] } }, rootNodeId: 'root' },
        classes: {},
      },
      slug: 'hero',
    })
    expect(row.tableId).toBe('layouts')
    const rows = await listDataRows(db, 'layouts')
    expect(rows.map((r) => r.slug)).toEqual(['hero'])
  })

  it('still rejects unknown table kinds after the constraint swap', async () => {
    await expect(
      db`insert into data_tables (id, name, slug, kind, singular_label, plural_label)
         values ('bogus', 'Bogus', 'bogus', 'nonsense', 'Bogus', 'Bogus')`,
    ).rejects.toThrow()
  })

  it('is recorded once — re-running migrations is a no-op', async () => {
    await runMigrations(db, sqliteMigrations)
    const tables = await listDataTables(db)
    expect(tables.filter((t) => t.id === 'layouts')).toHaveLength(1)
  })
})
