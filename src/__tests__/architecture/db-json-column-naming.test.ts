/**
 * Architecture Gate — JSON Column Naming Convention
 *
 * Every column in the Postgres schema whose declared type is `jsonb` must have
 * a name ending in `_json`. This convention is not merely cosmetic:
 *
 *   - The SQLite adapter (`server/db/sqlite.ts`) auto-parses column values
 *     whose keys end in `_json` (see `normalizeSqliteRow`). Columns that store
 *     JSON but lack the suffix will be returned as raw strings instead of
 *     parsed objects under SQLite, causing silent data-shape divergence.
 *   - It makes JSON payload columns instantly recognisable in query results,
 *     schema diffs, and repository code.
 *
 * Assertions:
 *   1. Every `jsonb`-typed column in `migrations-pg.ts` has a name ending `_json`.
 *   2. Every such column appears in the corresponding `migrations-sqlite.ts`
 *      migration declared as `text` (SQLite's JSON storage type).
 *
 * @see server/db/sqlite.ts — normalizeSqliteRow (auto-parse by _json suffix)
 * @see server/db/migrations-pg.ts — Postgres schema source of truth
 * @see server/db/migrations-sqlite.ts — SQLite dialect translations
 */

import { describe, test, expect } from 'bun:test'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonbColumn {
  /** Column name as it appears in the DDL. */
  name: string
  /** Migration ID where the column is declared. */
  migrationId: string
}

/**
 * Matches column declarations of the form `<name>  jsonb` (with any amount of
 * whitespace between name and type). Does NOT match `::jsonb` casts because
 * the `::` delimiter has no surrounding whitespace before `jsonb`.
 */
const JSONB_COL_RE = /(\w+)\s+jsonb\b/g

function extractJsonbColumns(): JsonbColumn[] {
  const result: JsonbColumn[] = []
  for (const migration of pgMigrations) {
    JSONB_COL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = JSONB_COL_RE.exec(migration.sql)) !== null) {
      result.push({ name: m[1], migrationId: migration.id })
    }
  }
  return result
}

/**
 * Matches column declarations of the form `<name>  text` (with any amount of
 * whitespace between name and type). Collects all column names declared as
 * `text` in the provided SQL string.
 */
const TEXT_COL_RE = /(\w+)\s+text\b/g

function extractTextColumnNames(sql: string): Set<string> {
  const names = new Set<string>()
  TEXT_COL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEXT_COL_RE.exec(sql)) !== null) {
    names.add(m[1])
  }
  return names
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('JSON column naming — _json suffix required on all jsonb columns', () => {
  const jsonbColumns = extractJsonbColumns()

  test('every jsonb column in migrations-pg.ts has a name ending in _json', () => {
    const violations = jsonbColumns.filter((c) => !c.name.endsWith('_json'))

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }

    const lines = violations.map(
      (c) => `  ${c.name}  (declared in migration ${c.migrationId})`,
    )

    throw new Error(
      `[db-json-column-naming] ${violations.length} jsonb column(s) in migrations-pg.ts ` +
        `lack the required _json suffix.\n` +
        `The SQLite adapter auto-parses columns by the _json suffix — a column that ` +
        `stores JSON without this suffix will be returned as a raw string under SQLite.\n` +
        `Rename each column to end with _json.\n\n` +
        `Violations:\n` +
        lines.join('\n'),
    )
  })

  test('every jsonb column from migrations-pg.ts appears as text somewhere in migrations-sqlite.ts', () => {
    // SQLite migration files sometimes use no-op migrations (`select 1`) when
    // the column was already included in an earlier CREATE TABLE statement.
    // For example, PG adds `granted_permissions_json jsonb` via ALTER TABLE in
    // migration 006, but SQLite already included it in the CREATE TABLE in 004.
    // Therefore we check across ALL SQLite migrations, not just the same-ID one.
    const allSqliteTextCols = new Set<string>()
    for (const migration of sqliteMigrations) {
      for (const name of extractTextColumnNames(migration.sql)) {
        allSqliteTextCols.add(name)
      }
    }

    // Deduplicate by column name (the same column may appear in multiple PG
    // migrations — e.g. declared in CREATE TABLE then referenced in ALTER TABLE).
    const seen = new Set<string>()
    const missing: string[] = []
    for (const col of jsonbColumns) {
      if (seen.has(col.name)) continue
      seen.add(col.name)
      if (!allSqliteTextCols.has(col.name)) {
        missing.push(`  ${col.name}  (first seen in PG migration ${col.migrationId})`)
      }
    }

    if (missing.length === 0) {
      expect(missing).toHaveLength(0)
      return
    }

    throw new Error(
      `[db-json-column-naming] ${missing.length} jsonb column(s) from migrations-pg.ts ` +
        `are not declared as text anywhere in migrations-sqlite.ts.\n` +
        `Every jsonb column must be mirrored as a text column in the SQLite dialect schema.\n` +
        `Note: SQLite may declare the column in an earlier migration's CREATE TABLE rather\n` +
        `than in the same-numbered migration — this test checks the full schema, not per-migration.\n\n` +
        `Missing:\n` +
        missing.join('\n'),
    )
  })
})
