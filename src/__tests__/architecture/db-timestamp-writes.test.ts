/**
 * Architecture Gate — Timestamp Writes
 *
 * Two rules keep every timestamp column holding one shape on both dialects:
 *
 *   1. Repository code never stamps with SQL `current_timestamp`. It binds an
 *      ISO 8601 string from JS (`nowIso()` in `@core/utils/isoDate`). On
 *      SQLite `current_timestamp` writes `YYYY-MM-DD HH:MM:SS`, which V8 parses
 *      as local time, sorts before the ISO `T` form, and compares wrongly
 *      against a bound ISO cutoff — and only on SQLite installs outside UTC,
 *      so a UTC `bun test` never notices.
 *   2. A DDL `default current_timestamp` (the three tables that predate the
 *      ISO `strftime` default, plus `schema_migrations`) may only sit on a
 *      column ending in `_at`: that suffix is what the SQLite adapter's
 *      `normalizeSqliteRow` keys on to rewrite the legacy shape on read.
 *
 * Scanned: every `.ts` file under `server/`, comments stripped. The two
 * migration files are exempt from rule 1 (a committed migration is history and
 * its DML cannot bind a JS value; migration 030 rewrote what those stamps
 * left behind), but every SQLite migration after 030 must stamp with the ISO
 * `strftime` form and default new columns to it, so the space form can never
 * come back through DDL either.
 *
 * @see server/db/sqlite.ts — normalizeSqliteRow
 * @see server/db/migrations-sqlite.ts — 030_iso_timestamps rewrote the stored rows
 * @see src/__tests__/db/sqlite-timestamp-normalization.test.ts — the read contract
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const SCAN_ROOT = join(PROJECT_ROOT, 'server')
/** Committed migrations: their DML is history and cannot bind JS values. Rule 2 still applies. */
const MIGRATION_FILES = new Set(['server/db/migrations-pg.ts', 'server/db/migrations-sqlite.ts'])
/** From here on, SQLite migrations stamp and default with the ISO strftime form. */
const ISO_REWRITE_MIGRATION_ID = '030_iso_timestamps'

/** Strips JS line and block comments so prose mentions don't false-positive. */
const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm
/** Collapses `${…}` interpolations so a positional VALUES list splits cleanly on commas. */
const INTERPOLATION_RE = /\$\{[^}]*\}/g

const SET_RE = /\b(\w+)\s*=\s*current_timestamp\b/gi
const INSERT_RE = /insert\s+into\s+\w+\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/gi
const DDL_DEFAULT_RE = /\b(\w+)\s+(?:text|timestamptz)\b[^,()]*?\bdefault\s+current_timestamp\b/gi

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (extname(entry) === '.ts') out.push(full)
  }
  return out
}

interface Violation {
  file: string
  detail: string
}

export function findTimestampWriteViolations(
  source: string,
  file: string,
  { dml = true }: { dml?: boolean } = {},
): Violation[] {
  const stripped = source.replace(COMMENT_RE, '').replace(INTERPOLATION_RE, '?')
  const out: Violation[] = []
  if (dml) {
    for (const m of stripped.matchAll(SET_RE)) {
      out.push({ file, detail: `${m[1]} = current_timestamp — bind nowIso() instead` })
    }
    for (const m of stripped.matchAll(INSERT_RE)) {
      const columns = m[1]!.split(',').map((c) => c.trim())
      const values = m[2]!.split(',').map((v) => v.trim().toLowerCase())
      values.forEach((value, i) => {
        if (value === 'current_timestamp') {
          out.push({ file, detail: `insert stamps ${columns[i] ?? `position ${i}`} with current_timestamp — bind nowIso() instead` })
        }
      })
    }
  }
  for (const m of stripped.matchAll(DDL_DEFAULT_RE)) {
    if (!m[1]!.endsWith('_at')) {
      out.push({ file, detail: `${m[1]} defaults to current_timestamp but does not end in _at` })
    }
  }
  return out
}

describe('Timestamp writes — bind nowIso(), never stamp with current_timestamp', () => {
  test('no file under server/ stamps a column with current_timestamp, and DDL defaults sit on *_at columns', () => {
    const violations = walk(SCAN_ROOT).flatMap((file) => {
      const rel = relative(PROJECT_ROOT, file)
      return findTimestampWriteViolations(readFileSync(file, 'utf8'), rel, { dml: !MIGRATION_FILES.has(rel) })
    })

    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}: ${v.detail}`)
      throw new Error(
        `[db-timestamp-writes] ${violations.length} timestamp write(s) break the one-shape rule.\n` +
          `Repositories bind ISO 8601 from JS: \`const now = nowIso()\` then \`updated_at = \${now}\`.\n` +
          `SQL current_timestamp writes "YYYY-MM-DD HH:MM:SS" on SQLite, which sorts and compares ` +
          `differently from the ISO form every other row holds.\n\n` +
          `Violations:\n` +
          lines.join('\n'),
      )
    }
    expect(violations).toHaveLength(0)
  })

  test(`SQLite migrations after ${ISO_REWRITE_MIGRATION_ID} never write or default with current_timestamp`, () => {
    const offenders = sqliteMigrations
      .filter((m) => m.id > ISO_REWRITE_MIGRATION_ID)
      .filter((m) => /\bcurrent_timestamp\b/i.test(m.sql))
      .map((m) => m.id)
    expect(offenders).toEqual([])
  })

  test('the scanner recognises every write shape it guards against', () => {
    const sample = `
      await db\`update users set display_name = \${name}, updated_at = current_timestamp where id = \${id}\`
      await db\`insert into user_preferences (user_id, key, value_json, updated_at)
               values (\${userId}, \${key}, \${writeJson(value)}, current_timestamp)\`
      await db.unsafe(\`create table t (id text primary key, locked_until text not null default current_timestamp)\`)
      await db.unsafe(\`create table ok (id text primary key, applied_at text not null default current_timestamp)\`)
    `
    expect(findTimestampWriteViolations(sample, 'sample.ts').map((v) => v.detail)).toEqual([
      'updated_at = current_timestamp — bind nowIso() instead',
      'insert stamps updated_at with current_timestamp — bind nowIso() instead',
      'locked_until defaults to current_timestamp but does not end in _at',
    ])
  })
})
