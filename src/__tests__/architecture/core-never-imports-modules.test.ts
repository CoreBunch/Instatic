/**
 * Architecture Source-Scan — core never imports modules
 *
 * `src/core/` is the bottom of the frontend dependency stack: modules, admin,
 * and the server all import it, and it imports none of them. A core→modules
 * import inverts that layering — the engine starts depending on the block
 * catalogue it exists to power, and anything that wants the engine without the
 * first-party modules (tests, the plugin SDK, server-side rendering paths)
 * drags them in anyway.
 *
 * The last such import (`@core/publisher/renderLoop` → `@modules/base/utils/
 * htmlTag`) was removed by hoisting `resolveHtmlTag` into
 * `@core/htmlAttributes`. Shared logic a module and the engine both need
 * belongs core-side; only module-specific pieces (editor components,
 * `PropertyControl` builders, render functions) stay under `src/modules/`.
 *
 * The scan checks every static import/export specifier in `src/core/`:
 *
 *   - `@modules/...` alias specifiers are violations outright.
 *   - Relative specifiers are resolved against the importing file and flagged
 *     when they land inside `src/modules/`. (Plain substring matching would
 *     false-positive on e.g. `src/core/plugin-sdk/builders` importing its
 *     sibling `../modules`, which resolves inside core.)
 *
 * Server code is deliberately out of scope: `server/` side-effect-imports
 * `@modules/base` to populate the module registry for publishing, which is the
 * correct direction (top of the stack pulling in the catalogue).
 *
 * One allowlisted directory, for the same reason:
 *
 *   - `src/core/plugin-sdk/cli/` — the `instatic-plugin` CLI. An executable
 *     entry point that always runs under Bun, never reaches a browser bundle,
 *     and is deliberately kept out of the SDK barrel. Its pack-compile
 *     environment side-effect-imports `@modules/base` to populate the module
 *     registry, exactly as `server/` does — the tool at the top of the stack
 *     pulling in the catalogue, not the engine depending upward.
 *
 * @see docs/architecture.md — "Layer responsibilities" → dependency direction
 * @see src/core/htmlAttributes/tags.ts — the hoisted tag-resolution logic
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { dirname, extname, join, relative, resolve, sep } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const CORE_ROOT = join(PROJECT_ROOT, 'src/core')
const MODULES_ROOT = join(PROJECT_ROOT, 'src/modules')

/** Executable entry points under src/core/ — see the docblock. */
const ALLOWLISTED_DIRS = [join(CORE_ROOT, 'plugin-sdk/cli')]

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (['.ts', '.tsx'].includes(extname(full))) {
      out.push(full)
    }
  }
  return out
}

/**
 * Static import/export specifiers: `import … from 'x'`, `export … from 'x'`,
 * side-effect `import 'x'`, and dynamic `import('x')`. Comment mentions of
 * module paths don't match — the regexes require the statement shape.
 */
const SPECIFIER_RES = [
  /(?:^|\n)\s*(?:import|export)\s[^'"\n]*from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const re of SPECIFIER_RES) {
    for (const match of source.matchAll(re)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

function resolvesIntoModules(file: string, specifier: string): boolean {
  if (specifier.startsWith('@modules/')) return true
  if (!specifier.startsWith('.')) return false
  const resolved = resolve(dirname(file), specifier)
  return resolved === MODULES_ROOT || resolved.startsWith(MODULES_ROOT + sep)
}

describe('core never imports modules', () => {
  test('no file under src/core/ imports from src/modules/', () => {
    const files = walk(CORE_ROOT)
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      if (ALLOWLISTED_DIRS.some((dir) => file.startsWith(dir + sep))) continue
      const source = readFileSync(file, 'utf8')
      for (const specifier of importSpecifiers(source)) {
        if (resolvesIntoModules(file, specifier)) {
          violations.push(`${relative(PROJECT_ROOT, file)} → '${specifier}'`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `src/core/ must not import src/modules/ — hoist the shared logic into a core module instead.\n\n` +
          violations.join('\n'),
      )
    }

    expect(violations).toEqual([])
  })
})
