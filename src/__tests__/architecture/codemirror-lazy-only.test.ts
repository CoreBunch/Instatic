/**
 * Architecture Source-Scan — CodeMirror lazy-load enforcement
 *
 * The CodeMirror 6 family (`codemirror`, `@codemirror/*`, `@lezer/*`) is large
 * — the published chunk is ~605 kB raw / ~208 kB gzipped. It is loaded lazily
 * via `React.lazy()` in `src/admin/pages/site/code-editor/CodeEditorPanel.tsx`
 * so the editor's startup bundle never pays for it on admin first paint.
 *
 * That invariant is currently only protected by a code comment in
 * `vite.config.ts` ("We deliberately do NOT chunk @codemirror / @lezer /
 * codemirror — they are already isolated via React.lazy()"). A single static
 * `import` from anywhere in the eager admin graph silently undoes the win.
 *
 * This gate enforces the invariant at the source level:
 *
 *   The ONLY production source files that may statically import from
 *   `codemirror`, `@codemirror/<anything>`, or `@lezer/<anything>` are the
 *   lazy chunk's own modules under `src/admin/pages/site/code-editor/`:
 *   `CodeMirrorEditor.tsx` (the React.lazy entry) and the helper modules it
 *   alone imports (theme, locked regions, syntax diagnostics). A second
 *   assertion pins that boundary: nothing outside that set may statically
 *   import one of the helpers, or the chunk would leak into the eager graph.
 *
 * Dynamic `import('codemirror')` calls are also acceptable because they are
 * code-split by the bundler regardless of where they live, but a separate
 * lazy module is the established pattern in this codebase and should be
 * preferred over scattering dynamic imports through the editor.
 *
 * If you genuinely need CodeMirror in a new place, extend
 * `CodeMirrorEditor.tsx`, or add a sibling helper under `code-editor/`,
 * list it in LAZY_CHUNK_MODULES below and import it ONLY from another
 * listed module — do NOT add a static import of the CodeMirror packages in
 * the eager graph.
 *
 * @see vite.config.ts — "no manual chunk for codemirror" comment
 * @see src/admin/pages/site/code-editor/CodeMirrorEditor.tsx — the lazy module
 * @see src/admin/pages/site/code-editor/CodeEditorPanel.tsx — React.lazy boundary
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')

// ---------------------------------------------------------------------------
// File walker (shared pattern from no-anthropic-sdk.test.ts / no-third-party-icons.test.ts)
// ---------------------------------------------------------------------------

function collectFiles(dir: string, exts = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

// Scan production source under src/. We deliberately skip `src/__tests__/`
// — test files may contain the package names as literal patterns (this file
// is one of them) and would self-match.
const PROD_DIRS = ['admin', 'core', 'modules', 'ui', 'editor', 'app', 'lib'].map((d) =>
  join(SRC_ROOT, d)
)

function collectProdFiles(): string[] {
  return PROD_DIRS.flatMap((dir) => collectFiles(dir))
}

// ---------------------------------------------------------------------------
// CodeMirror lazy-load enforcement
// ---------------------------------------------------------------------------

// The lazy chunk: the React.lazy entry plus the helpers only it imports.
// Paths are relative to SRC_ROOT (i.e. relative to `src/`).
const LAZY_CHUNK_DIR = 'admin/pages/site/code-editor/'
const LAZY_CHUNK_ENTRY = `${LAZY_CHUNK_DIR}CodeMirrorEditor.tsx`
const LAZY_CHUNK_HELPERS = [
  'codeMirrorTheme.ts',
  'lockedRegions.ts',
  'syntaxDiagnostics.ts',
  'uidAttributes.tsx',
  'contextCompletions.ts',
  'htmlContextCompletions.ts',
  'cssContextCompletions.ts',
  'jsContextCompletions.ts',
  'syntaxNode.ts',
  'uidInspector.ts',
  'cssVarShorthand.ts',
  'documentDiff.ts',
  'formatDocument.ts',
]
const LAZY_CHUNK_MODULES = new Set([
  LAZY_CHUNK_ENTRY,
  ...LAZY_CHUNK_HELPERS.map((file) => `${LAZY_CHUNK_DIR}${file}`),
])

// Matches: import ... from 'codemirror' / '@codemirror/...' / '@lezer/...'
//          require('codemirror') / require('@codemirror/...') / require('@lezer/...')
//
// We test against three explicit families so the error message can name
// which family triggered the violation.
const CODEMIRROR_IMPORT_PATTERNS: { family: string; pattern: RegExp }[] = [
  {
    family: 'codemirror',
    pattern: /(?:from\s+['"]codemirror['"]|require\s*\(\s*['"]codemirror['"]\s*\))/,
  },
  {
    family: '@codemirror/*',
    pattern: /(?:from\s+['"]@codemirror\/[^'"]+['"]|require\s*\(\s*['"]@codemirror\/[^'"]+['"]\s*\))/,
  },
  {
    family: '@lezer/*',
    pattern: /(?:from\s+['"]@lezer\/[^'"]+['"]|require\s*\(\s*['"]@lezer\/[^'"]+['"]\s*\))/,
  },
]

describe('CodeMirror lazy-load enforcement', () => {
  it(`only the lazy chunk (${LAZY_CHUNK_ENTRY} + its helpers) may statically import codemirror / @codemirror / @lezer`, () => {
    const allFiles = collectProdFiles()
    const violations: { file: string; family: string }[] = []

    for (const file of allFiles) {
      const rel = relative(SRC_ROOT, file)
      if (LAZY_CHUNK_MODULES.has(rel)) continue

      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }

      for (const { family, pattern } of CODEMIRROR_IMPORT_PATTERNS) {
        if (pattern.test(source)) {
          violations.push({ file: rel, family })
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) => `  src/${v.file}  →  imports ${v.family}`
      )
      throw new Error(
        `[codemirror-lazy-only] CodeMirror must stay behind the React.lazy()\n` +
        `boundary in CodeEditorPanel.tsx. Only src/${LAZY_CHUNK_ENTRY} and its\n` +
        `listed helpers may statically import CodeMirror packages. A static import\n` +
        `elsewhere pulls the ~605 kB CodeMirror bundle into the eager admin\n` +
        `chunk and undoes the code-split.\n\n` +
        `Move the new code into a helper under src/admin/pages/site/code-editor/,\n` +
        `list it in LAZY_CHUNK_HELPERS, and import it only from the lazy chunk.\n\n` +
        `Violations:\n${lines.join('\n')}`
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('no file outside the lazy chunk statically imports one of its helpers', () => {
    // The helpers pull CodeMirror in; importing one from the eager graph
    // would drag the whole chunk along just as a direct CM import would.
    const helperImport = new RegExp(
      `from\\s+['"](?:\\.\\/|@site\\/code-editor\\/|@admin\\/pages\\/site\\/code-editor\\/)(?:${LAZY_CHUNK_HELPERS.join('|')})['"]`,
    )
    const violations: string[] = []
    for (const file of collectProdFiles()) {
      const rel = relative(SRC_ROOT, file)
      if (LAZY_CHUNK_MODULES.has(rel)) continue
      if (helperImport.test(readFileSync(file, 'utf8'))) violations.push(`src/${rel}`)
    }
    expect(violations).toEqual([])
  })

  it('every lazy-chunk module actually exists at the documented path', () => {
    // Sanity check — if a module is renamed or moved without updating
    // LAZY_CHUNK_MODULES above, the gate would silently start failing for
    // the lazy chunk itself. Detect that case directly.
    for (const rel of LAZY_CHUNK_MODULES) {
      expect(existsSync(join(SRC_ROOT, rel))).toBe(true)
    }
  })
})
