/**
 * Architecture Source-Scan — one render-time URL-scheme guard, not three.
 *
 * `src/core/html-sanitize/index.ts` owns the decision of whether a URL scheme
 * is safe to EMIT into an `href` / `src` / `action` attribute. No other module
 * may declare its own `isSafeUrl` / `safeUrl` / `hasDangerousUrlScheme` /
 * `urlScheme` — importing and re-exporting the canonical ones is fine.
 *
 * WHY THIS MATTERS
 * ----------------
 * GHSA-pqcp-872g-gmp8 existed because three implementations had drifted apart:
 *
 *   1. `src/core/html-sanitize/index.ts` — a denylist that normalised with
 *      `.replace(/[\t\n\r]/g, '').trim()`. `trim()` leaves U+0000–U+0008 and
 *      U+000E–U+001F in place, but the WHATWG URL parser strips the whole
 *      U+0000–U+0020 range before reading a scheme, so 27 of 32 C0 code points
 *      slipped a `javascript:` URL past it.
 *   2. `src/core/plugin-sdk/builders/html.ts` — an independent two-regex
 *      denylist, strictly weaker still: no whitespace handling at all (a plain
 *      leading space defeated it) and no `data:` case.
 *   3. `src/core/utils/urlValidation.ts` — a `new URL().protocol` allowlist
 *      whose header claimed the publisher guard was "the stricter enforcement
 *      gate" when it was in fact the loosest of the three.
 *
 * Fixing one copy leaves the others open. This gate makes redeclaring one of
 * those four names fail the build.
 *
 * SCOPE — what this gate does NOT cover
 * -------------------------------------
 * It is keyed on the four canonical names, so it catches a *copy of the render
 * guard*, not every scheme check in the repo. Http(s)-only validators that
 * serve a different purpose exist and are deliberately out of scope:
 *   - `isHttpUrl` (src/admin/pages/site/property-controls/MediaLibraryControl.tsx)
 *   - `isValidUrl` (src/core/forms/validation.ts) — submitted form values
 *   - the SSRF / import guards under `server/` and `src/core/siteImport/`
 * Those never decide what is safe to emit into an attribute. If one ever grows
 * that responsibility, route it through `@core/html-sanitize` instead of
 * widening this list.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')

const SCAN_ROOTS = ['src/admin', 'src/core', 'src/modules', 'src/ui', 'server']

/** The one module allowed to define scheme-safety predicates. */
const CANONICAL_GUARD = 'src/core/html-sanitize/index.ts'

/**
 * Names that must resolve to the canonical implementation everywhere. A file
 * may `export { safeUrl } from '@core/html-sanitize'` (re-export) or wrap it,
 * but may not `function safeUrl(...)` its own scheme logic.
 */
const GUARD_NAMES = ['isSafeUrl', 'safeUrl', 'hasDangerousUrlScheme', 'urlScheme']

/**
 * Deliberate exceptions. Extend only with a written justification.
 *
 * §1 `src/core/plugin-sdk/builders/html.ts` — declares a `safeUrl` that is a
 *    thin non-escaping wrapper delegating to the canonical `isSafeUrl` (the
 *    `html` tag escapes interpolations itself, so escaping there would
 *    double-encode `&`). It carries no scheme logic of its own.
 */
const ALLOWLIST = new Set([CANONICAL_GUARD, 'src/core/plugin-sdk/builders/html.ts'])

function collectFiles(dir: string, exts = ['.ts', '.tsx']): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) results.push(...collectFiles(full, exts))
    else if (exts.includes(extname(entry))) results.push(full)
  }
  return results
}

/**
 * Blank out comment and string-literal content, preserving every newline so
 * reported line numbers still match the file on disk.
 *
 * A regex pass is not sufficient in either direction. Deleting block comments
 * outright shifts every subsequent line number (most files here open with a
 * JSDoc header). And a `/*` appearing inside a string literal would open a
 * fake comment that swallows real code up to the next closing delimiter —
 * letting a genuine second guard hide behind `const glob = '/*'`. So this
 * walks the source once, tracking whether it is inside a string, a template
 * literal, a line comment, or a block comment.
 */
function blankCommentsAndStrings(source: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (ch === '\n') {
      // Newlines always survive verbatim, and end a line comment.
      out += '\n'
      if (state === 'line') state = 'code'
      i += 1
      continue
    }

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        out += '  '
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        out += '  '
        i += 2
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      out += ch
      i += 1
      continue
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        out += '  '
        i += 2
        continue
      }
      out += ' '
      i += 1
      continue
    }

    if (state === 'line') {
      out += ' '
      i += 1
      continue
    }

    // Inside a string / template literal: blank the content, honour escapes,
    // and keep the closing quote so the code around it stays parseable.
    if (ch === '\\') {
      out += '  '
      i += 2
      continue
    }
    const closes =
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    if (closes) {
      state = 'code'
      out += ch
    } else {
      out += ' '
    }
    i += 1
  }

  return out
}

describe('URL-scheme safety is defined in exactly one module', () => {
  it('has no second declaration of a scheme guard', () => {
    const offenders: string[] = []

    for (const root of SCAN_ROOTS) {
      for (const filePath of collectFiles(join(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, filePath)
        if (ALLOWLIST.has(rel)) continue

        const raw = readFileSync(filePath, 'utf8')
        const scannable = blankCommentsAndStrings(raw).split('\n')
        const original = raw.split('\n')

        scannable.forEach((line, index) => {
          for (const name of GUARD_NAMES) {
            // `function safeUrl(`, `const safeUrl =`, `let safeUrl =` — a
            // declaration. Import / re-export / call sites are untouched.
            const declared = new RegExp(
              `(?:^|\\s)(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*[:=])`,
            )
            if (declared.test(line)) {
              offenders.push(`  ${rel}:${index + 1} -> ${original[index].trim().slice(0, 110)}`)
            }
          }
        })
      }
    }

    expect(offenders).toEqual([])
  })

  it('every consumer resolves to the same function instance', async () => {
    const core = await import('@core/html-sanitize')
    const publisher = await import('@core/publisher')

    // The publisher barrel re-exports rather than reimplementing.
    expect(publisher.isSafeUrl).toBe(core.isSafeUrl)
    expect(publisher.safeUrl).toBe(core.safeUrl)
  })

  it('does not let a declaration hide behind a string containing a comment opener', () => {
    // Regression guard for the scanner itself: a naive regex strip treats the
    // `/*` inside this string as a comment opener and swallows the function.
    const evasion = ["const globPattern = '/*'", 'export function safeUrl(v) { return v }', "const tail = '*/'"].join(
      '\n',
    )
    const scanned = blankCommentsAndStrings(evasion).split('\n')

    expect(scanned).toHaveLength(3)
    expect(scanned[1]).toContain('function safeUrl')
  })

  it('preserves line numbers across block comments', () => {
    const source = ['/**', ' * Header.', ' */', 'const after = 1'].join('\n')
    const scanned = blankCommentsAndStrings(source).split('\n')

    expect(scanned).toHaveLength(4)
    expect(scanned[3]).toContain('const after')
  })
})
