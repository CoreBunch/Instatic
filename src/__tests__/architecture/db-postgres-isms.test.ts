/**
 * Architecture Source-Scan — Postgres-ism Isolation
 *
 * No file under `server/` that imports `DbClient` (i.e., any file that issues
 * DB queries) may use Postgres-specific SQL syntax or types, EXCEPT the two
 * migration files which are explicitly allowlisted:
 *
 *   - `server/db/migrations-pg.ts`     — the Postgres dialect migration file;
 *                                            this is its entire job.
 *   - `server/db/migrations-sqlite.ts` — the SQLite dialect translation; its
 *                                            JSDoc and inline comments document the
 *                                            PG→SQLite type mappings (e.g. "jsonb → text",
 *                                            "distinct on → window function") and are
 *                                            not SQL that executes against any DB.
 *
 * Files that do not import `DbClient` are excluded from the scan because they
 * cannot issue DB queries directly. This avoids false positives from legitimate
 * JS uses of `now()` in non-DB code (e.g. `options.now ?? Date.now`).
 *
 * All scanned files must use dialect-neutral SQL only:
 *
 *   - `current_timestamp` instead of `now()`
 *   - No `::int` or `::jsonb` PG casts
 *   - No `any($N::...)` PG array-binding syntax
 *   - No `distinct on` (use a window-function subquery for SQLite compat)
 *   - No DDL types: `bytea`, `timestamptz`, `jsonb` (use `blob`, `text`, `text`)
 *
 * This gate ensures the repository layer is portable across both the Postgres
 * adapter (production) and the SQLite adapter (embedded / tests).
 *
 * @see server/db/migrations-pg.ts   — Postgres dialect migrations
 * @see server/db/migrations-sqlite.ts — SQLite dialect translations
 * @see server/db/sqlite.ts          — why _json suffix matters (normalizeSqliteRow)
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
/**
 * Roots that contain DbClient-consuming code in the current layout.
 * The legacy `server/cms/` namespace was split into `server/{repositories,
 * handlers/cms,auth,db,plugins,publish}/` — this gate previously scanned only
 * the now-missing `server/cms/` and silently inspected zero files (F-0007).
 * Scanning all of `server/` is safe because the `DbClient` import filter below
 * already scopes to query-issuing files.
 */
const SCAN_ROOTS = [join(PROJECT_ROOT, 'server')]

/** Strips JS line and block comments so PG type names in JSDoc don't false-positive. */
const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm

// ---------------------------------------------------------------------------
// File walker — .ts files only, recursive
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Allowlist — files that are explicitly exempt from this gate
// ---------------------------------------------------------------------------

const ALLOWLISTED = new Set([
  // Postgres migration file: PG DDL types and syntax are its entire purpose.
  join(PROJECT_ROOT, 'server/db/migrations-pg.ts'),
  // SQLite migration file: its JSDoc/inline comments document the PG-to-SQLite
  // type translation table (e.g. "jsonb → text", "distinct on (…) → window
  // function subquery"). Those comment-only mentions are not live SQL.
  join(PROJECT_ROOT, 'server/db/migrations-sqlite.ts'),
  // Dialect-aware helper: deliberately knows about both PG (->>) and SQLite (json_extract) JSON syntax.
  // The only legitimate caller of either operator in the repo. Egress is independently gated by
  // json-extract-egress.test.ts.
  join(PROJECT_ROOT, 'server/db/jsonExtract.ts'),
])

/**
 * Strip JS line + block comments. Preserves line numbering by replacing every
 * non-newline byte inside a comment with a space, so violation line numbers
 * still line up with the original source.
 */
function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
}

// ---------------------------------------------------------------------------
// Forbidden patterns
// ---------------------------------------------------------------------------

interface ForbiddenPattern {
  /** Human-readable name shown in violation messages. */
  name: string
  /** Regex applied line-by-line; a match is a violation. */
  regex: RegExp
  /**
   * Optional per-line exclusion: if this regex also matches the same line,
   * skip it. Used to suppress JS-land false positives (e.g. `Date.now()`).
   */
  lineExclusion?: RegExp
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    // `now()` is Postgres-specific; SQLite uses `current_timestamp` (no parens).
    // Exclude lines that contain `Date.now()` — that is JS, not SQL.
    name: 'now() in SQL — use current_timestamp instead',
    regex: /\bnow\(\)/,
    lineExclusion: /\bDate\.now\(\)/,
  },
  {
    name: '::int cast — use plain integer arithmetic or JS coercion',
    regex: /::int\b/,
  },
  {
    name: '::jsonb cast — omit the cast; use plain text in SQLite',
    regex: /::jsonb\b/,
  },
  {
    name: 'any($N::...) PG array binding — use JS-side iteration with per-id queries',
    regex: /\bany\s*\(\s*\$\d+\s*::/,
  },
  {
    name: 'distinct on — use a window-function subquery for SQLite compat',
    regex: /\bdistinct on\b/i,
  },
  {
    name: 'bytea DDL type — use blob for SQLite compat',
    regex: /\bbytea\b/,
  },
  {
    name: 'timestamptz DDL type — use text (ISO 8601) for SQLite compat',
    regex: /\btimestamptz\b/,
  },
  {
    name: 'jsonb DDL type — use text for SQLite compat',
    regex: /\bjsonb\b/,
  },
]

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  /** Relative path from project root, e.g. `server/repositories/setup.ts`. */
  file: string
  /** 1-based line number. */
  line: number
  /** Forbidden pattern name. */
  pattern: string
  /** The exact matched text. */
  match: string
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function scanForViolations(): Violation[] {
  const files = SCAN_ROOTS.flatMap((root) => walk(root)).filter(
    (f) => !ALLOWLISTED.has(f),
  )
  const violations: Violation[] = []

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // Only check files that import DbClient — those are the only files that can
    // issue DB queries. Non-DB files (renderers, runtime bundlers, dependency
    // resolvers, etc.) may legitimately use now() as a JS function reference
    // (e.g. `options.now ?? Date.now`) and must not be flagged.
    if (!content.includes('DbClient')) continue

    // Strip JS comments so PG type names referenced in JSDoc / inline comments
    // (e.g. `bytea → blob`, `JSONB`-mentioning docstrings in server/db/sqlite.ts)
    // don't false-positive. PG-ism patterns must match LIVE SQL.
    const lines = stripComments(content).split('\n')

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]

      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.lineExclusion?.test(line)) continue

        const m = pattern.regex.exec(line)
        if (m !== null) {
          violations.push({
            file: relative(PROJECT_ROOT, file),
            line: lineIdx + 1,
            pattern: pattern.name,
            match: m[0],
          })
        }
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Postgres-ism isolation — DbClient-consuming server files', () => {
  test('SCAN_ROOTS resolve to at least one existing directory with .ts files', () => {
    // Defensive sanity check: if SCAN_ROOTS ever rots the way `server/cms/` did,
    // walk() will return an empty list and the gate will silently inspect zero
    // files. Fail loudly here so the next layout move is caught immediately.
    const total = SCAN_ROOTS.flatMap((root) => walk(root)).length
    if (total === 0) {
      throw new Error(
        `[db-postgres-isms] SCAN_ROOTS resolved to zero .ts files — the layout has likely ` +
          `moved. Update SCAN_ROOTS in this file to match the current DbClient-consumer ` +
          `directories.`,
      )
    }
    expect(total).toBeGreaterThan(0)
  })

  test('scanner finds at least one DbClient-importing file (sanity check that the gate runs)', () => {
    // After excluding the allowlist, there must be at least one DbClient consumer
    // left to scan — otherwise the loop body never executes and the gate is a no-op.
    const files = SCAN_ROOTS.flatMap((root) => walk(root)).filter(
      (f) => !ALLOWLISTED.has(f),
    )
    const dbConsumers = files.filter((f) =>
      readFileSync(f, 'utf8').includes('DbClient'),
    )
    expect(dbConsumers.length).toBeGreaterThan(0)
  })

  test('no DbClient-consuming file (outside the migration allowlist) uses Postgres-specific SQL', () => {
    const violations = scanForViolations()

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }

    const lines = violations.map(
      (v) =>
        `  ${v.file}:${v.line} — [${v.pattern}]\n` +
        `    matched: ${JSON.stringify(v.match)}`,
    )

    throw new Error(
      `[db-postgres-isms] ${violations.length} Postgres-specific SQL construct(s) found in DbClient-consuming files.\n` +
        `These constructs are incompatible with the SQLite adapter and break dialect portability.\n` +
        `Replace each with its dialect-neutral equivalent (see pattern name for guidance).\n\n` +
        `Violations:\n` +
        lines.join('\n') +
        `\n\nAllowlisted files (PG syntax is acceptable there):\n` +
        `  server/db/migrations-pg.ts\n` +
        `  server/db/migrations-sqlite.ts`,
    )
  })
})
