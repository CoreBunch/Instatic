/**
 * Architecture gate: every `applyFilter('publish.html', ...)` call in the
 * server must pass a third argument (the context object).
 *
 * This ensures that plugin filter handlers for `publish.html` always receive
 * `{ siteId, pageId, slug, path }` in their context — without this, plugins that
 * destructure those fields would silently receive `undefined`.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { globSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('publish.html filter always receives context', () => {
  it('every applyFilter("publish.html", ...) call in server/ passes a third argument', async () => {
    // Find all .ts files under server/
    const files = globSync('server/**/*.ts', { cwd: ROOT })

    const violations: string[] = []
    for (const file of files) {
      const source = await read(file)
      // Match calls to applyFilter with 'publish.html' as the first argument.
      // A compliant call has a third argument (anything after the second comma).
      // We use a multiline-aware regex to find the pattern.
      const matches = source.matchAll(/applyFilter\s*\(\s*['"`]publish\.html['"`]/g)
      for (const match of matches) {
        // Extract the text from the match start to the end of the statement
        // (heuristic: scan for the closing paren, counting nesting).
        const start = match.index ?? 0
        const snippet = source.slice(start, start + 500)
        // Count arguments by looking for commas outside nested parens/brackets.
        // A two-argument call ends at the second comma-then-closing-paren pattern.
        // We check for the presence of a third argument by requiring at least
        // two commas at top-level depth within the call.
        let depth = 0
        let topLevelCommas = 0
        let i = snippet.indexOf('(')
        if (i < 0) continue
        i++ // step past the opening paren
        for (; i < snippet.length; i++) {
          const ch = snippet[i]
          if (ch === '(' || ch === '[' || ch === '{') depth++
          else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) break
            depth--
          } else if (ch === ',' && depth === 0) {
            topLevelCommas++
          }
        }
        if (topLevelCommas < 2) {
          const lineNo = source.slice(0, start).split('\n').length
          violations.push(`${file}:${lineNo} — applyFilter('publish.html', ...) missing third context argument`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `applyFilter('publish.html', ...) calls missing context argument:\n` +
        violations.join('\n'),
      )
    }
  })
})
