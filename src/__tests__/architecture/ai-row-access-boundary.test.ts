/**
 * Architecture gate: every server-side reader of data rows under `server/ai/`
 * goes through the shared row-access rules in `server/auth/dataAccess.ts`.
 *
 * The AI read tools and the MCP relay act on behalf of a caller whose
 * capability set may be narrower than the session that owns the server
 * process. Reading rows straight from the repositories (`getDataRow`,
 * `listDataRows`, `searchDataRows`) skips the table-family and ownership
 * checks the HTTP data routes enforce, which is how a content.edit.own caller
 * came to read every other user's drafts through the tool surface
 * (GHSA-x5cc) after the HTTP side had been fixed (GHSA-x69h). The rule is
 * file-scoped: no direct row repository read anywhere under `server/ai/`
 * except through `resolveRowAccess` / `rowVisibilityFor`.
 */

import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const AI_ROOT = join(ROOT, 'server', 'ai')

/**
 * Direct row reads. `listDataRows(` and `searchDataRows(` are allowed only
 * when the call passes the shared visibility filter, so those two are
 * checked for a `rowVisibilityFor(` argument rather than banned outright.
 */
const BARE_GET_ROW = /(?<![.\w])getDataRow\s*\(/
const LIST_OR_SEARCH = /(?<![.\w])(listDataRows|searchDataRows)\s*\(([^)]*)\)/g

/**
 * `treeService.ts` reads the row to resolve a page-tree field and takes an
 * `assertAccess` callback; its only callers are the plugin host content
 * handlers, which pass `assertContentTableAccess`. It is the one sanctioned
 * reader outside `dataAccess.ts`.
 */
const ALLOWLIST = new Set(['server/ai/content/treeService.ts'])

function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

async function tsFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath, e.name))
}

describe('AI-layer row reads go through the shared row-access rules', () => {
  it('no file under server/ai reads a row with a bare getDataRow()', async () => {
    const offenders: string[] = []
    for (const file of await tsFilesIn(AI_ROOT)) {
      const rel = relative(ROOT, file)
      if (ALLOWLIST.has(rel)) continue
      const code = stripNonCode(await readFile(file, 'utf-8'))
      if (BARE_GET_ROW.test(code)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('every listDataRows / searchDataRows call under server/ai passes rowVisibilityFor()', async () => {
    const offenders: string[] = []
    for (const file of await tsFilesIn(AI_ROOT)) {
      const rel = relative(ROOT, file)
      if (ALLOWLIST.has(rel)) continue
      const code = stripNonCode(await readFile(file, 'utf-8'))
      for (const match of code.matchAll(LIST_OR_SEARCH)) {
        if (!/rowVisibilityFor\s*\(/.test(match[2] ?? '')) offenders.push(`${rel}: ${match[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the MCP relay authorizes document tools through resolveRowAccess', async () => {
    const source = await readFile(join(AI_ROOT, 'mcp', 'contentAuthorization.ts'), 'utf-8')
    expect(source).toMatch(/await\s+resolveRowAccess\(/)
  })
})
