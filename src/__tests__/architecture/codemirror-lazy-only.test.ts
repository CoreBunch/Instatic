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
 *   The ONLY production source file that may statically import from
 *   `codemirror`, `@codemirror/<anything>`, or `@lezer/<anything>` is
 *   `src/admin/pages/site/code-editor/CodeMirrorEditor.tsx` — the lazy module
 *   itself.
 *
 * Dynamic `import('codemirror')` calls are also acceptable because they are
 * code-split by the bundler regardless of where they live, but a separate
 * lazy module is the established pattern in this codebase and should be
 * preferred over scattering dynamic imports through the editor.
 *
 * If you genuinely need CodeMirror in a new place, extend
 * `CodeMirrorEditor.tsx` (or split a sibling lazy module under
 * `code-editor/`) and import from your new module via `React.lazy()` —
 * do NOT add a static import of the CodeMirror packages in the eager graph.
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

// The files allowed to statically import the CodeMirror packages — the base
// lazy module and its collab sibling (both only reachable through
// React.lazy() boundaries; the sibling adds the y-codemirror binding for
// the Plugin IDE's co-edited buffers).
// Paths are relative to SRC_ROOT (i.e. relative to `src/`).
const ALLOWED_CONSUMERS = new Set([
  'admin/pages/site/code-editor/CodeMirrorEditor.tsx',
  'admin/pages/site/code-editor/CollabCodeMirrorEditor.tsx',
  // Read-only agent code/diff blocks — lazy-loaded by ToolCallRow, same
  // chunk graph as the code editor.
  'admin/pages/site/code-editor/AgentCodeView.tsx',
  // Theme + language stacks shared by the three viewers above (non-component
  // module so the component files keep react-refresh eligibility).
  'admin/pages/site/code-editor/codeMirrorShared.ts',
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
  it('only the code-editor lazy modules may statically import codemirror / @codemirror / @lezer', () => {
    const allFiles = collectProdFiles()
    const violations: { file: string; family: string }[] = []

    for (const file of allFiles) {
      const rel = relative(SRC_ROOT, file)
      if (ALLOWED_CONSUMERS.has(rel)) continue

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
        `[codemirror-lazy-only] CodeMirror must stay behind a React.lazy()\n` +
        `boundary. Only ${[...ALLOWED_CONSUMERS].map((f) => `src/${f}`).join(' and ')} are\n` +
        `permitted to statically import CodeMirror packages. A static import\n` +
        `elsewhere pulls the ~605 kB CodeMirror bundle into the eager admin\n` +
        `chunk and undoes the code-split.\n\n` +
        `Move the new code into a lazy module under src/admin/pages/site/code-editor/\n` +
        `and consume it via React.lazy(() => import('./<your-module>')).\n\n` +
        `Violations:\n${lines.join('\n')}`
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('the allowed consumer files actually exist at the documented paths', () => {
    // Sanity check — if a lazy module is renamed or moved without updating
    // ALLOWED_CONSUMERS above, the gate would silently start failing for
    // the lazy module itself. Detect that case directly.
    for (const consumer of ALLOWED_CONSUMERS) {
      expect(existsSync(join(SRC_ROOT, consumer))).toBe(true)
    }
  })
})
