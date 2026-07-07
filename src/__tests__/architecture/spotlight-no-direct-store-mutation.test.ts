/**
 * Architecture Gate — Spotlight commands must not mutate the editor store directly.
 *
 * Files under src/admin/spotlight/commands/* may call exported store actions
 * (e.g. useEditorStore.getState().undo()) but MUST NOT call
 * useEditorStore.setState() or import store internals (slices, helpers, types
 * that are not public exports of store.ts).
 *
 * Rationale: Spotlight is a UI layer that orchestrates existing store actions.
 * It must not become a second model layer by directly mutating Mutative state.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const COMMANDS_DIR = join(SRC_ROOT, 'admin/spotlight/commands')

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

// Direct setState call patterns that are forbidden in commands/
const FORBIDDEN_PATTERNS = [
  /useEditorStore\.setState\s*\(/,
  /useEditorStore\.subscribe\s*\(/,
]

// Store-internal import paths (slices, helpers) that commands must not import
// Commands may only use the public useEditorStore from @site/store/store
const FORBIDDEN_IMPORTS = [
  /from\s+['"]@site\/store\/slices\//,
  /from\s+['"]@site\/store\/types['"]/,
  /from\s+['"][./]+store\/slices\//,
]

describe('Spotlight commands — no direct store mutation', () => {
  it('commands/ files do not call useEditorStore.setState directly', () => {
    const files = collectTsFiles(COMMANDS_DIR)
    const violations: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const rel = file.replace(SRC_ROOT, 'src/')

      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${rel}: direct store mutation via ${pattern}`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[spotlight-no-direct-store-mutation] Commands must not call setState directly.\n' +
          'Use exported store actions (e.g. useEditorStore.getState().undo()) instead.\n\n' +
          violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('commands/ files do not import store internals (slices, types)', () => {
    const files = collectTsFiles(COMMANDS_DIR)
    const violations: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const rel = file.replace(SRC_ROOT, 'src/')

      for (const pattern of FORBIDDEN_IMPORTS) {
        if (pattern.test(source)) {
          violations.push(`${rel}: imports store internals via ${pattern}`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[spotlight-no-direct-store-mutation] Commands must not import store slice internals.\n' +
          'Import only from @site/store/store (public useEditorStore).\n\n' +
          violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
