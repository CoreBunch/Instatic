/**
 * Architecture Source-Scan — Core Barrel Deep Imports
 *
 * These `src/core/` engine modules publish a public `index.ts` barrel as their
 * canonical entrypoint:
 *   - `@core/page-tree`
 *   - `@core/module-engine`
 *   - `@core/visualComponents`
 *   - `@core/publisher`
 *   - `@core/framework`
 *   - `@core/framework-schema`
 *   - `@core/fonts`
 *   - `@core/seo`
 *
 * Per the barrel convention (CLAUDE.md → "Barrel imports"): everything OUTSIDE
 * a module imports through its barrel; files INSIDE the module import each
 * other via relative paths. External code must NOT reach past the barrel into a
 * concrete file (`@core/<module>/<file>`) — that bypasses the public surface
 * and re-couples callers to the module's internal layout.
 *
 * This gate fails on any `import … from '@core/<module>/<subpath>'` (or the
 * `export … from` / dynamic `import('@core/<module>/<subpath>')` forms) found
 * outside the owning module. The bare barrel path `@core/<module>` is allowed.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'

const ROOT = join(import.meta.dir, '../../..')

const BARRELLED_MODULES = [
  'page-tree',
  'module-engine',
  'visualComponents',
  'publisher',
  'framework',
  'framework-schema',
  'fonts',
  'seo',
]

// Scan production + test sources in both the app and the server.
const SCAN_ROOTS = [join(ROOT, 'src'), join(ROOT, 'server')]

// A module never deep-imports itself, so its own directory is exempt (its
// internal files legitimately use relative paths, not deep `@core/<self>`).
// Trailing separator so `framework` does not prefix-match `framework-schema`.
const OWN_MODULE_DIRS = BARRELLED_MODULES.map((m) => join(ROOT, 'src', 'core', m) + '/')

function collectFiles(dir: string): string[] {
  const exts = ['.ts', '.tsx', '.mts', '.cts']
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectFiles(full))
    } else if (exts.includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

const DEEP_IMPORT = new RegExp(
  `(?:from|import\\()\\s*['"]@core/(?:${BARRELLED_MODULES.join('|')})/[^'"]+['"]`,
)

describe('Core barrel deep imports — external callers use the barrel, never a concrete file', () => {
  it('no external file deep-imports a barrelled @core module concrete file', () => {
    const violations: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectFiles(root)) {
        if (OWN_MODULE_DIRS.some((dir) => filePath.startsWith(dir))) continue

        const source = readFileSync(filePath, 'utf8')
        source.split('\n').forEach((line, i) => {
          if (DEEP_IMPORT.test(line)) {
            violations.push(`${filePath.replace(ROOT + '/', '')}:${i + 1}  ${line.trim()}`)
          }
        })
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Deep imports into a barrelled core module found.\n` +
          `Import through the module barrel (e.g. '@core/publisher') instead of a concrete file.\n\n` +
          violations.join('\n'),
      )
    }

    expect(violations).toEqual([])
  })
})
