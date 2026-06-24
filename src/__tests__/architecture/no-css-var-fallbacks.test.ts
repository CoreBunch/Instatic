/**
 * Architecture Gate — no fallback values inside `var(--name, ...)`.
 *
 * Every CSS custom property the editor / admin / UI code reads must already
 * exist somewhere it is reachable from. Writing `var(--text-disabled,
 * var(--text-subtle))` or `var(--font-mono, monospace)` is a
 * hallucination: either the named token exists (so the fallback is dead code
 * the next reader has to puzzle over) or it does not (in which case the
 * fallback is silently masking a missing token).
 *
 * The rule is: only `var(--name)` — no comma, no fallback. Defaults for
 * dynamic, JS-set custom properties belong in a CSS rule (`:root` or a
 * component selector) so the value is owned by exactly one place, not
 * scattered across every `var()` reader.
 *
 * Scope: every `.module.css` and the global `globals.css` under `src/admin`,
 * `src/admin/pages/site`, `src/ui`, plus any inline-style `var(...)` strings inside
 * `.ts` / `.tsx` files in the same directories.
 *
 * Module CSS in `src/modules/` is intentionally exempt — those styles ship to
 * published pages, where editor tokens are not available and a fallback can
 * be the only sensible default.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const SCAN_ROOTS = [
  join(SRC_ROOT, 'admin'),
  join(SRC_ROOT, 'editor'),
  join(SRC_ROOT, 'ui'),
]
const GLOBALS_CSS = join(SRC_ROOT, 'styles/globals.css')

/**
 * Match `var(--name` followed by a comma at the same paren depth. We can't use
 * a single regex because a fallback may itself contain a balanced `var(...)`,
 * so we walk the string and bail out on the first top-level comma.
 */
function findVarFallbackHits(source: string): Array<{ line: number; snippet: string }> {
  const hits: Array<{ line: number; snippet: string }> = []
  const VAR_OPEN = /var\(\s*--[\w-]+/g

  let match: RegExpExecArray | null
  while ((match = VAR_OPEN.exec(source)) !== null) {
    // Walk forward from the end of the matched name, balancing parens.
    let i = match.index + match[0].length
    let depth = 1
    let hasFallback = false
    while (i < source.length && depth > 0) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 1) {
        hasFallback = true
        break
      }
      i++
    }
    if (hasFallback) {
      // Compute 1-based line number of the `var(` token.
      const before = source.slice(0, match.index)
      const line = before.split('\n').length
      const lineStart = before.lastIndexOf('\n') + 1
      const lineEnd = source.indexOf('\n', match.index)
      const snippet = source
        .slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
        .trim()
        .slice(0, 140)
      hits.push({ line, snippet })
    }
  }
  return hits
}

/** Strip `/* ... *\/` block comments and `// ...` line comments. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function collectFiles(dir: string, exts: ReadonlyArray<string>): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(entry))) {
      // Only `.module.css` (not arbitrary `.css`) for stylesheets, but the
      // caller filters on extension only — narrow `.css` here.
      if (extname(entry) === '.css' && !entry.endsWith('.module.css')) continue
      results.push(full)
    }
  }
  return results
}

describe('CSS var() fallback policy — no `var(--name, fallback)`', () => {
  it('every var() in editor / admin / ui CSS modules and globals.css uses a bare token', () => {
    const offenders: string[] = []

    const cssFiles: string[] = []
    for (const root of SCAN_ROOTS) {
      cssFiles.push(...collectFiles(root, ['.css']))
    }
    if (existsSync(GLOBALS_CSS)) cssFiles.push(GLOBALS_CSS)

    for (const filePath of cssFiles) {
      const stripped = stripComments(readFileSync(filePath, 'utf8'))
      for (const hit of findVarFallbackHits(stripped)) {
        offenders.push(`  ${relative(SRC_ROOT, filePath)}:${hit.line} -> ${hit.snippet}`)
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'Fallback values inside var(--name, ...) are banned in editor / admin / ui CSS.\n' +
          'Either the token exists (drop the redundant fallback) or it does not\n' +
          '(define the token in src/styles/globals.css, or in a base selector for\n' +
          'JS-driven custom properties). Fallbacks hide hallucinated tokens.\n\n' +
          'Violations:\n' +
          offenders.join('\n'),
      )
    }

    expect(offenders).toEqual([])
  })

  it('no inline var(--name, ...) string in editor / admin / ui .ts(x) sources', () => {
    const offenders: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectFiles(root, ['.ts', '.tsx'])) {
        const stripped = stripComments(readFileSync(filePath, 'utf8'))
        for (const hit of findVarFallbackHits(stripped)) {
          offenders.push(`  ${relative(SRC_ROOT, filePath)}:${hit.line} -> ${hit.snippet}`)
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'Fallback values inside var(--name, ...) are banned in editor / admin / ui sources.\n' +
          'Use a bare var(--name) reference and define defaults in CSS.\n\n' +
          'Violations:\n' +
          offenders.join('\n'),
      )
    }

    expect(offenders).toEqual([])
  })
})
