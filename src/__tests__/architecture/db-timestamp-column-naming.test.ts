/**
 * Architecture Gate — Timestamp Column Naming Convention
 *
 * SQL `current_timestamp` may only ever land in a column whose name ends in
 * `_at`. The SQLite adapter (`server/db/sqlite.ts`, `normalizeSqliteRow`)
 * rewrites SQLite's `YYYY-MM-DD HH:MM:SS` output to ISO 8601 UTC by that
 * suffix. A `current_timestamp` written anywhere else would reach
 * repositories in a shape V8 parses as *local* time — and only on SQLite
 * installs running outside UTC, so `bun test` on a UTC machine would never
 * notice.
 *
 * Three write shapes are scanned across every `.ts` file under `server/`
 * (comments stripped):
 *
 *   1. `col = current_timestamp`                            (UPDATE / upsert SET)
 *   2. `insert into t (a, b) values (?, current_timestamp)`  (positional INSERT)
 *   3. `col text ... default current_timestamp`             (DDL, incl. migrations)
 *
 * @see server/db/sqlite.ts — normalizeSqliteRow
 * @see src/__tests__/db/sqlite-timestamp-normalization.test.ts — the read contract
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const SCAN_ROOT = join(PROJECT_ROOT, 'server')

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
  column: string
  shape: string
}

function findViolations(file: string): Violation[] {
  const source = readFileSync(file, 'utf8').replace(COMMENT_RE, '').replace(INTERPOLATION_RE, '?')
  const rel = relative(PROJECT_ROOT, file)
  const out: Violation[] = []
  const check = (column: string, shape: string) => {
    if (!column.endsWith('_at')) out.push({ file: rel, column, shape })
  }

  for (const m of source.matchAll(SET_RE)) check(m[1]!, 'col = current_timestamp')
  for (const m of source.matchAll(DDL_DEFAULT_RE)) check(m[1]!, 'default current_timestamp')
  for (const m of source.matchAll(INSERT_RE)) {
    const columns = m[1]!.split(',').map((c) => c.trim())
    const values = m[2]!.split(',').map((v) => v.trim().toLowerCase())
    values.forEach((value, i) => {
      if (value === 'current_timestamp') check(columns[i] ?? `<position ${i}>`, 'positional insert')
    })
  }
  return out
}

describe('Timestamp column naming — current_timestamp only lands in *_at columns', () => {
  test('every current_timestamp write under server/ targets a column ending in _at', () => {
    const violations = walk(SCAN_ROOT).flatMap(findViolations)

    if (violations.length > 0) {
      const lines = violations.map((v) => `  ${v.file}: ${v.column}  (${v.shape})`)
      throw new Error(
        `[db-timestamp-column-naming] ${violations.length} current_timestamp write(s) target ` +
          `a column that does not end in _at.\n` +
          `The SQLite adapter rewrites current_timestamp's "YYYY-MM-DD HH:MM:SS" output to ` +
          `ISO 8601 UTC by the _at suffix; anywhere else it reaches repositories in a shape ` +
          `V8 parses as local time. Rename the column to <something>_at, or bind an ISO ` +
          `string from JS instead of stamping in SQL.\n\n` +
          `Violations:\n` +
          lines.join('\n'),
      )
    }
    expect(violations).toHaveLength(0)
  })

  test('the scan sees the known writers (guards against a silently empty scan)', () => {
    const source = readFileSync(join(SCAN_ROOT, 'repositories/userPreferences.ts'), 'utf8')
      .replace(COMMENT_RE, '')
      .replace(INTERPOLATION_RE, '?')
    expect([...source.matchAll(SET_RE)].map((m) => m[1])).toContain('updated_at')
    const inserts = [...source.matchAll(INSERT_RE)]
    expect(inserts.length).toBeGreaterThan(0)
    expect(inserts[0]![2]!.toLowerCase()).toContain('current_timestamp')

    const ddl = readFileSync(join(SCAN_ROOT, 'db/runMigrations.ts'), 'utf8').replace(COMMENT_RE, '')
    expect([...ddl.matchAll(DDL_DEFAULT_RE)].map((m) => m[1])).toContain('applied_at')
  })
})
