/**
 * Architecture gate: visitor-data framework IDOR isolation.
 *
 * The load-bearing security rule for the per-visitor-data framework: visitor
 * identity is derived SOLELY from the validated session cookie — never from
 * loop filters, query params, path segments, or form bodies. If any of these
 * tests fail, a visitor could be shown (or stamped as the owner of) another
 * visitor's data.
 *
 * These are static source-analysis checks (read file contents, assert
 * invariants). They are intentionally strict: the cookie is the one and only
 * identity source, enforced at the resolver boundary and the loop-source
 * boundary. Defence-in-depth note: visitor ids are nanoid (21 chars, ~126
 * bits, unguessable) — but unguessability is secondary; cookie-derived
 * identity is the primary IDOR guard.
 *
 * See `docs/PER-VISITOR-DATA-SPEC.md` § "Security invariants".
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

/**
 * Strip comments + string literals so docstrings/strings never satisfy or
 * fail a structural scan. Mirrors the helper in
 * `plugin-sandbox-invariants.test.ts` (not a full parser, but sufficient for
 * grep-style structural checks over source).
 */
function stripCommentsAndStrings(source: string): string {
  let s = source.replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
  s = s.replace(/\/\/[^\n]*/g, ' ') // line comments
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''") // single-quoted strings
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""') // double-quoted strings
  return s
}

describe('visitor-data framework IDOR isolation', () => {
  // ─────────────────────────────────────────────────────────────────────
  // 1. The resolver accepts no identity id parameter — cookie map only.
  // ─────────────────────────────────────────────────────────────────────
  it('resolveVisitorFromCookie derives identity only from the cookie map, not an id param', async () => {
    const source = stripCommentsAndStrings(await read('server/visitor-auth/visitorData.ts'))

    // The public resolver exists and takes the cookie map as its identity input.
    expect(source).toContain('export async function resolveVisitorFromCookie')
    expect(source).toContain('cookies: Record<string, string>')

    // It must reach identity through the cached session validator (cookie path),
    // not by accepting/resolving a visitor/user/owner id.
    expect(source).toContain('validateVisitorSession')

    // No identity-id parameter may influence resolution. The resolver signature
    // has (db, cookies) — ban an explicit visitor/user/owner id param name.
    expect(source).not.toMatch(/resolveVisitorFromCookie\s*\([^)]*\bvisitorId\b/)
    expect(source).not.toMatch(/resolveVisitorFromCookie\s*\([^)]*\buserId\b/)
    expect(source).not.toMatch(/resolveVisitorFromCookie\s*\([^)]*\bownerId\b/)
  })

  // ─────────────────────────────────────────────────────────────────────
  // 2. Visitor loop sources read identity from ctx.visitor, never from
  //    request filters/query/path (which a caller could forge).
  // ─────────────────────────────────────────────────────────────────────
  for (const rel of ['src/core/loops/sources/visitorCurrent.ts', 'src/core/loops/sources/visitorOwnedRows.ts']) {
    it(`identity in ${rel} comes from ctx.visitor, not request input`, async () => {
      const source = stripCommentsAndStrings(await read(rel))

      // Identity is the cookie-resolved ctx.visitor.
      expect(source).toContain('ctx.visitor')

      // The owner filter binds ctx.visitor.id (ownedRows). Confirm ctx.visitor
      // is referenced — then forbid deriving a visitor from request input.
      // ctx.filters.tableId is allowed (it selects a TABLE, not an identity).
      expect(source).not.toMatch(/ctx\.request\.query\s*\[?\s*['"]?\w*([Ii]d|[Uu]serId|[Oo]wnerId)/)
      expect(source).not.toMatch(/ctx\.request\.path\b/)
      expect(source).not.toMatch(/ctx\.filters\s*\.\s*(visitor|user|owner)/i)
      // No visitor/user/owner id read off the slug (request identity).
      expect(source).not.toMatch(/ctx\.request\.(slug|query)\b[^=]*=\s*ctx\.visitor/)
    })
  }

  it('visitor.owned-rows filters owned rows by ctx.visitor.id as a bound parameter', async () => {
    const source = stripCommentsAndStrings(await read('src/core/loops/sources/visitorOwnedRows.ts'))
    // Identity is captured from ctx.visitor (cookie-derived) …
    expect(source).toMatch(/const\s+visitor\s*=\s*ctx\.visitor/)
    // … used as the visitor_user_id bind in BOTH the count and the page query …
    expect(source).toMatch(/visitor_user_id\s*=\s*\$\{visitor\.id\}/)
    // … and the anonymous guard returns empty before any query runs.
    expect(source).toMatch(/if\s*\(\s*!visitor\s*\)\s*return\s*\{\s*items:\s*\[\]\s*,\s*totalItems:\s*0\s*\}/)
  })

  // ─────────────────────────────────────────────────────────────────────
  // 3. The form handler stamps the visitor only from the validated session,
  //    never from the submitted body or validated cells.
  // ─────────────────────────────────────────────────────────────────────
  it('form handler stamps visitor_user_id from the session, never the body', async () => {
    const source = stripCommentsAndStrings(await read('server/forms/handler.ts'))

    // Cookie/session path is the only source of identity here.
    expect(source).toContain('validateVisitorSession')
    expect(source).toContain('capturesVisitorOwner')

    // visitorUserId must NOT be assigned from request body or the validated cells.
    expect(source).not.toMatch(/visitorUserId\s*=\s*body\b/)
    expect(source).not.toMatch(/visitorUserId\s*=\s*(?:validation\.)?cells\b/)
    expect(source).not.toMatch(/visitor_user_id\s*=\s*\$\{body/)
  })

  // ─────────────────────────────────────────────────────────────────────
  // 4. Both visitor sources are registered so the framework is wired up.
  // ─────────────────────────────────────────────────────────────────────
  it('both visitor loop sources are registered in the sources index', async () => {
    const source = await read('src/core/loops/sources/index.ts')
    expect(source).toContain('VisitorCurrentSource')
    expect(source).toContain('VisitorOwnedRowsSource')
    expect(source).toMatch(/registerOrReplace\(VisitorCurrentSource\)/)
    expect(source).toMatch(/registerOrReplace\(VisitorOwnedRowsSource\)/)
  })
})
