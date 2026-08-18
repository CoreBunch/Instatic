/**
 * Architecture gate — loop code under `src/core/loops/` issues SQL via the
 * LoopSourceDb tagged-template surface, so it must obey the same
 * dialect-neutral rules as `server/cms/*` repositories.
 *
 * The scan covers the whole `loops/` tree, not just `sources/`: the cell
 * filter's dialect switch lives in `cellFilter.ts` one level up, and a gate
 * that stops at `sources/` would be blind to exactly the file that renders
 * the most engine-specific SQL in the subsystem.
 *
 * Mirrors `db-postgres-isms.test.ts` for a different scan root.
 *
 * Sources that don't issue SQL (e.g. site.pages.ts which reads from the
 * in-memory site document) trivially pass — none of the patterns will
 * match without a DB query.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const LOOP_SOURCES_ROOT = join(PROJECT_ROOT, 'src/core/loops')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (extname(entry) === '.ts') out.push(full)
  }
  return out
}

interface ForbiddenPattern {
  name: string
  regex: RegExp
  lineExclusion?: RegExp
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { name: 'now() in SQL', regex: /\bnow\(\)/, lineExclusion: /\bDate\.now\(\)/ },
  { name: '::int cast', regex: /::int\b/ },
  { name: '::jsonb cast', regex: /::jsonb\b/ },
  { name: 'any($N::...) PG array binding', regex: /\bany\s*\(\s*\$\d+\s*::/ },
  { name: 'distinct on', regex: /\bdistinct on\b/i },
  { name: 'jsonb DDL type', regex: /\bjsonb\b/ },
  { name: 'timestamptz DDL type', regex: /\btimestamptz\b/ },
  { name: 'bytea DDL type', regex: /\bbytea\b/ },
]

describe('loop sources — dialect-neutral SQL', () => {
  test('no Postgres-isms in source files', () => {
    const files = walk(LOOP_SOURCES_ROOT)
    const violations: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.lineExclusion && pattern.lineExclusion.test(line)) continue
          if (pattern.regex.test(line)) {
            violations.push(
              `${relative(PROJECT_ROOT, file)}:${idx + 1} — ${pattern.name}: ${line.trim()}`,
            )
          }
        }
      })
    }

    expect(violations).toEqual([])
  })
})
