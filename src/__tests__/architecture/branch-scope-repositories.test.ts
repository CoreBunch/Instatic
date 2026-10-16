/**
 * Architecture Gate — branch scope on the branched tables.
 *
 * Every row of `site`, `data_tables`, and `data_rows` belongs to a branch
 * (see `docs/features/branches.md`). Reading or writing them without saying
 * which branch is how one branch's content leaks into another, so:
 *
 *   1. Every exported function in the repositories that own those tables
 *      takes a `BranchScope` parameter, except the main-only publish paths
 *      listed below with their justification.
 *   2. Any raw SQL on those tables OUTSIDE the repositories names `branch_id`
 *      — either bound from a scope or pinned to `'main'` — unless the file is
 *      allowlisted below because a physical id already carries the branch.
 *   3. The physical-id scheme (`<branch>:<logical>`) is minted in exactly one
 *      place, `src/core/branches/ids.ts`; nobody else joins ids with a colon.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')

const SCOPED_REPOSITORY_FILES = [
  'server/repositories/site.ts',
  'server/repositories/data/tables.ts',
  'server/repositories/data/rows/read.ts',
  'server/repositories/data/rows/mutations.ts',
  'server/repositories/data/rows/bulk.ts',
  'server/repositories/data/rows/apply.ts',
  'server/repositories/data/rows/filter.ts',
  'server/repositories/data/rows/search.ts',
  'server/repositories/data/rows/schedule.ts',
  'server/repositories/data/rows/import.ts',
]

/**
 * Exported repository functions that legitimately have no scope parameter.
 * §1 — main-only by definition: the scheduler only ever publishes main rows.
 * §2 — reads users, not a branched table.
 */
const SCOPELESS_REPOSITORY_FUNCTIONS = new Set([
  'listDuePublishSchedules', // §1
  'listDataAuthorOptions', // §2
  'siteRowId', // helper that derives the physical shell key from a scope
])

/**
 * Files outside the repositories with raw SQL on a branched table where the
 * branch is carried by a physical id instead of a `branch_id` predicate.
 * §3 — the loop source binds `physicalId(branchId, tableId)` from `@core/branches`.
 * §4 — the setup screen reads the main shell by its well-known physical key `default`.
 */
const RAW_SQL_ALLOWLIST = new Set([
  'src/core/loops/sources/dataRows.ts', // §3
  'server/handlers/cms/setup.ts', // §4
])

const RAW_SQL_SCAN_ROOTS = ['server', 'src/core']
const RAW_SQL_EXEMPT_PREFIXES = [
  'server/repositories/',
  'server/branches/',
  'server/db/',
]

const BRANCHED_TABLE_SQL = /\b(from|into|update|join)\s+(data_rows|data_tables|site)\b/i

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function collectFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      results.push(...collectFiles(full))
    } else if (extname(entry) === '.ts' && !entry.endsWith('.test.ts')) {
      results.push(full)
    }
  }
  return results
}

function exportedFunctions(source: string): Array<{ name: string; params: string }> {
  const out: Array<{ name: string; params: string }> = []
  const re = /export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g
  for (const match of source.matchAll(re)) {
    out.push({ name: match[1], params: match[2] })
  }
  return out
}

describe('branch-scope-repositories', () => {
  it('every scoped repository export takes a BranchScope', () => {
    const offenders: string[] = []
    for (const file of SCOPED_REPOSITORY_FILES) {
      for (const fn of exportedFunctions(read(file))) {
        if (SCOPELESS_REPOSITORY_FUNCTIONS.has(fn.name)) continue
        if (!/scope\s*:\s*BranchScope/.test(fn.params)) {
          offenders.push(`${file} → ${fn.name}(${fn.params.replace(/\s+/g, ' ').trim()})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('raw SQL on a branched table outside the repositories names branch_id', () => {
    const offenders: string[] = []
    for (const root of RAW_SQL_SCAN_ROOTS) {
      for (const full of collectFiles(join(ROOT, root))) {
        const rel = relative(ROOT, full)
        if (RAW_SQL_EXEMPT_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
        if (RAW_SQL_ALLOWLIST.has(rel)) continue
        const source = readFileSync(full, 'utf8')
        if (!BRANCHED_TABLE_SQL.test(source)) continue
        if (!/\bbranch_id\b/.test(source)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the physical id scheme is minted only in @core/branches', () => {
    const offenders: string[] = []
    const roots = ['server', 'src'].map((root) => join(ROOT, root))
    for (const root of roots) {
      for (const full of collectFiles(root)) {
        const rel = relative(ROOT, full)
        if (rel === 'src/core/branches/ids.ts') continue
        const source = readFileSync(full, 'utf8')
        if (/\$\{\s*(?:scope\.)?branchId\s*\}:\$\{/.test(source)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
