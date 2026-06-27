/**
 * Architecture Gate — System table seeds after fresh boot
 *
 * After applying the SQLite migrations to a fresh in-memory database, the
 * three system tables (`posts`, `pages`, `components`) must exist with:
 *
 *   - `system = 1` (the integer flag used by SQLite)
 *   - `fields_json` that parses to a valid array of `DataField` objects,
 *     each with the expected `builtIn: true` field ids.
 *
 * This test catches regressions where a migration edit accidentally drops a
 * seed row, removes the `system` column, or corrupts the built-in field list.
 *
 * @see server/db/migrations-sqlite.ts  — SQLite baseline migration
 * @see server/db/migrations-pg.ts      — Postgres baseline (same seed content)
 * @see src/core/data/schemas.ts        — DataFieldSchema
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { filterArray } from '@core/utils/typeboxHelpers'
import { DataFieldSchema } from '@core/data/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DataTableSeedRow {
  id: string
  system: number
  fields_json: unknown
}

let seededRows: DataTableSeedRow[]

beforeAll(async () => {
  // Boot a fresh in-memory SQLite database and apply all migrations.
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)

  const { rows } = await db<DataTableSeedRow>`
    select id, system, fields_json
    from data_tables
    where id in ('posts', 'pages', 'components', 'layouts')
    order by id asc
  `
  seededRows = rows
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('data_tables system seeds — four tables present after fresh boot', () => {
  test('all four system tables exist', () => {
    const ids = seededRows.map((r) => r.id).sort()
    expect(ids).toEqual(['components', 'layouts', 'pages', 'posts'])
  })

  test('all four system tables have system = 1', () => {
    for (const row of seededRows) {
      expect(row.system).toBe(1)
    }
  })

  test('posts fields_json parses and contains expected builtIn field ids', () => {
    const posts = seededRows.find((r) => r.id === 'posts')
    expect(posts).toBeDefined()
    const raw = Array.isArray(posts!.fields_json) ? posts!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const builtInIds = fields.filter((f) => f.builtIn).map((f) => f.id)
    expect(builtInIds).toContain('title')
    expect(builtInIds).toContain('slug')
    expect(builtInIds).toContain('body')
    expect(builtInIds).toContain('featuredMedia')
    expect(builtInIds).toContain('seo')
  })

  test('pages fields_json parses and contains expected builtIn field ids', () => {
    const pages = seededRows.find((r) => r.id === 'pages')
    expect(pages).toBeDefined()
    const raw = Array.isArray(pages!.fields_json) ? pages!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const builtInIds = fields.filter((f) => f.builtIn).map((f) => f.id)
    expect(builtInIds).toContain('title')
    expect(builtInIds).toContain('slug')
    expect(builtInIds).toContain('body')
    expect(builtInIds).toContain('seo')
    expect(builtInIds).toContain('templateEnabled')
    expect(builtInIds).toContain('templateTarget')
    expect(builtInIds).toContain('templatePriority')
  })

  test('components fields_json parses and contains expected builtIn field ids', () => {
    const components = seededRows.find((r) => r.id === 'components')
    expect(components).toBeDefined()
    const raw = Array.isArray(components!.fields_json) ? components!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const builtInIds = fields.filter((f) => f.builtIn).map((f) => f.id)
    expect(builtInIds).toContain('name')
    expect(builtInIds).toContain('slug')
    expect(builtInIds).toContain('body')
    expect(builtInIds).toContain('params')
    expect(builtInIds).toContain('classIds')
  })

  test('layouts fields_json parses and contains expected builtIn field ids', () => {
    const layouts = seededRows.find((r) => r.id === 'layouts')
    expect(layouts).toBeDefined()
    const raw = Array.isArray(layouts!.fields_json) ? layouts!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const builtInIds = fields.filter((f) => f.builtIn).map((f) => f.id)
    expect(builtInIds).toContain('name')
    expect(builtInIds).toContain('slug')
    expect(builtInIds).toContain('body')
    expect(builtInIds).toContain('classes')
  })

  test('layouts body field has type pageTree', () => {
    const layouts = seededRows.find((r) => r.id === 'layouts')
    expect(layouts).toBeDefined()
    const raw = Array.isArray(layouts!.fields_json) ? layouts!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const body = fields.find((f) => f.id === 'body')
    expect(body?.type).toBe('pageTree')
  })

  test('pages body field has type pageTree', () => {
    const pages = seededRows.find((r) => r.id === 'pages')
    expect(pages).toBeDefined()
    const raw = Array.isArray(pages!.fields_json) ? pages!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const body = fields.find((f) => f.id === 'body')
    expect(body?.type).toBe('pageTree')
  })

  test('components body field has type pageTree', () => {
    const components = seededRows.find((r) => r.id === 'components')
    expect(components).toBeDefined()
    const raw = Array.isArray(components!.fields_json) ? components!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const body = fields.find((f) => f.id === 'body')
    expect(body?.type).toBe('pageTree')
  })

  test('components params field has type fieldSchema', () => {
    const components = seededRows.find((r) => r.id === 'components')
    expect(components).toBeDefined()
    const raw = Array.isArray(components!.fields_json) ? components!.fields_json : []
    const fields = filterArray(DataFieldSchema, raw)
    const params = fields.find((f) => f.id === 'params')
    expect(params?.type).toBe('fieldSchema')
  })
})
