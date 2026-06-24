/**
 * Architecture Gate — global CSS token vocabulary.
 *
 * Admin chrome uses the Core Framework-style global token vocabulary directly.
 * Deprecated editor-prefixed tokens, rail/tag tint token families, and
 * scoped color alias tokens are banned so new styles do not reintroduce the
 * old overlapping design-token layers.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const REPO_ROOT = join(SRC_ROOT, '..')
const SCAN_ROOTS = [
  join(SRC_ROOT, 'admin'),
  join(SRC_ROOT, 'styles'),
  join(SRC_ROOT, 'ui'),
]
const DOC_FILES = [
  join(REPO_ROOT, 'docs/design.md'),
  join(REPO_ROOT, 'docs/reference/design-tokens.md'),
  join(REPO_ROOT, 'docs/reference/ui-primitives.md'),
]

const DEPRECATED_TOKEN_RE =
  /--(?:editor-[\w-]*|rail-tint-[\w-]*|tag-pill-tint-[\w-]*|panel-(?:bg|border|shadow[\w-]*)|input-(?:bg|border|shadow)[\w-]*|tooltip-(?:bg|fg|border|shadow)|spotlight-(?:backdrop|row-selected-bg|mark-bg|mark-fg|footer-bg|destructive-fg|confirm-bg|skeleton-base|skeleton-shimmer)|code-bg)\b/g

function collectFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectFiles(full))
      continue
    }
    if (['.css', '.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

describe('CSS token vocabulary — no deprecated global color token names', () => {
  it('uses Core Framework-style global tokens directly in source and design docs', () => {
    const offenders: string[] = []
    const files = [
      ...SCAN_ROOTS.flatMap(collectFiles),
      ...DOC_FILES.filter((filePath) => existsSync(filePath)),
    ]

    for (const filePath of files) {
      const raw = readFileSync(filePath, 'utf8')
      const source = extname(filePath) === '.md' ? raw : stripSourceComments(raw)
      for (const match of source.matchAll(DEPRECATED_TOKEN_RE)) {
        offenders.push(
          `  ${relative(REPO_ROOT, filePath)}:${lineNumber(source, match.index ?? 0)} -> ${match[0]}`,
        )
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'Deprecated CSS token names found.\n' +
          'Use the Core Framework-style global token vocabulary directly: ' +
          '--bg-*, --text-*, --border*, --overlay-*, --accent-* and semantic state tokens.\n\n' +
          'Violations:\n' +
          offenders.join('\n'),
      )
    }

    expect(offenders).toEqual([])
  })
})
