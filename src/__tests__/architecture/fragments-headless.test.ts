/**
 * Architecture Gate — `src/core/fragments/` is importable outside the app.
 *
 * Build scripts (the private template pipeline among them) import the
 * fragment engine by path under Bun:
 *
 *   import { extractFragment } from '<instatic>/src/core/fragments'
 *
 * so the WHOLE runtime import graph reachable from the barrel must stay
 * headless: no React, no admin or editor code, no UI or module code, no
 * server code, no DOM-only libraries, and only the small set of npm packages
 * that run anywhere (TypeBox, nanoid, fflate). A direct-import check is not
 * enough — one `@core/*` barrel that pulled in React would break the script —
 * so this walks the graph transitively, following `@core/*` aliases and
 * relative paths. Type-only imports are erased at runtime and are skipped.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'

const SRC = resolve(import.meta.dir, '../..')
const ENTRY = join(SRC, 'core/fragments/index.ts')

const ALLOWED_PACKAGES = [/^@sinclair\/typebox(\/.*)?$/, /^nanoid$/, /^fflate$/]

const RUNTIME_SPECIFIER_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

interface Graph {
  files: string[]
  packages: Map<string, string>
  violations: string[]
}

function walk(): Graph {
  const seen = new Set<string>()
  const packages = new Map<string, string>()
  const violations: string[] = []
  const queue = [ENTRY]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const rel = relative(SRC, file)
    if (file.endsWith('.tsx')) violations.push(`${rel}: .tsx file in the fragment import graph`)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(RUNTIME_SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      if (specifier.startsWith('@core/')) {
        const target = resolveFile(join(SRC, 'core', specifier.slice('@core/'.length)))
        if (!target) violations.push(`${rel}: cannot resolve ${specifier}`)
        else queue.push(target)
      } else if (specifier.startsWith('.')) {
        const target = resolveFile(resolve(dirname(file), specifier))
        if (!target) violations.push(`${rel}: cannot resolve ${specifier}`)
        else if (!target.startsWith(join(SRC, 'core'))) violations.push(`${rel}: leaves src/core via ${specifier}`)
        else queue.push(target)
      } else if (specifier.startsWith('@')) {
        if (!ALLOWED_PACKAGES.some((re) => re.test(specifier))) {
          violations.push(`${rel}: imports ${specifier}`)
        }
        packages.set(specifier, rel)
      } else {
        packages.set(specifier, rel)
        if (!ALLOWED_PACKAGES.some((re) => re.test(specifier))) {
          violations.push(`${rel}: imports package ${specifier}`)
        }
      }
    }
  }
  return { files: [...seen], packages, violations }
}

describe('fragments headless gate', () => {
  it('the runtime import graph from src/core/fragments stays headless', () => {
    const graph = walk()
    expect(graph.files.length).toBeGreaterThan(5)
    if (graph.violations.length > 0) {
      throw new Error(
        '[fragments headless] src/core/fragments must import only headless core modules\n'
        + 'and TypeBox / nanoid / fflate, transitively. Violations:\n'
        + graph.violations.map((v) => `  ${v}`).join('\n'),
      )
    }
    expect(graph.violations).toEqual([])
  })
})
