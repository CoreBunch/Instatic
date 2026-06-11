/**
 * Architecture Gate — keybindings registry is the single source of truth.
 *
 * Every keyboard shortcut in src/admin/ that combines a meta/ctrl modifier
 * with a letter/symbol key must be registered in keybindings.ts and handled
 * via `getKeybindingForCommand(id).match(e)`.
 *
 * This test greps for inline key-combo matchers (e.g. `e.metaKey && e.key === 'k'`)
 * that bypass the registry, and fails if it finds any in files outside the allowlist.
 *
 * Allowlisted files — consolidation touchpoints and legitimate exceptions:
 *   - keybindings.ts           — registry itself (defines match functions)
 *   - HelpKeybindingsList.tsx  — reads from registry, renders <kbd> tags
 *   - SpotlightRow.tsx         — reads from registry, renders <kbd> tags
 *   - CanvasRoot.tsx           — uses getKeybindingForCommand().match(e)
 *   - usePersistence.ts        — uses getKeybindingForCommand().match(e)
 *   - SpotlightRoot.tsx        — uses getKeybindingForCommand().match(e)
 *   - UndoRedoButtons.tsx      — uses getKeybindingForCommand().match(e)
 *   - useCanvas.ts             — canvas-specific zoom/pan shortcuts (not global)
 *   - Spotlight.tsx            — ⌘ symbol appears only in a JSDoc comment
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const ADMIN_SRC = join(SRC_ROOT, 'admin')

// ─── Allowlist (relative to SRC_ROOT) ────────────────────────────────────────

const ALLOWLIST = new Set([
  // The registry — allowed to contain match functions and shortcut strings
  'admin/spotlight/keybindings.ts',
  // Renderers — allowed to render <kbd> from registry data
  'admin/spotlight/HelpKeybindingsList.tsx',
  'admin/spotlight/SpotlightRow.tsx',
  // ⌘ symbol appears only in a JSDoc comment, not JSX output
  'admin/spotlight/Spotlight.tsx',
  // Handlers that use getKeybindingForCommand().match(e)
  'admin/pages/site/canvas/CanvasRoot.tsx',
  'admin/pages/site/hooks/usePersistence.ts',
  'admin/spotlight/SpotlightRoot.tsx',
  'admin/pages/site/canvas/UndoRedoButtons.tsx',
  // Canvas-specific zoom/pan shortcuts (Ctrl+0, f, 1, 2) — not global commands.
  // These are canvas viewport controls that don't belong in the palette registry.
  'admin/pages/site/hooks/useCanvas.ts',
])

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (full.includes('node_modules')) continue
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

/**
 * Strips single-line comments (//) from source before pattern testing
 * so that e.g. `// (first ⌘K)` in a JSDoc block doesn't false-positive.
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      // Remove everything from the first '//' that isn't inside a string.
      // Simple heuristic: if the line (trimmed) starts with '*' or '//',
      // it's a comment line — strip it entirely.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return ''
      return line
    })
    .join('\n')
}

/**
 * Patterns that indicate an inline key-combo matcher bypassing the registry.
 *
 * We only flag POSITIVE modifier checks (e.metaKey || e.ctrlKey) combined
 * with an e.key check for a single-character key. This excludes:
 *   - Negated modifiers: !(e.metaKey ...) or !e.ctrlKey
 *   - Long key names: 'Escape', 'Enter', 'Tab', 'ArrowUp', etc.
 *   - ShiftKey-only patterns (Enter+Shift for multiline textarea, etc.)
 *
 * The pattern requires:
 *   1. A POSITIVE e.metaKey or e.ctrlKey reference (not preceded by `!`)
 *   2. Followed (within 80 chars) by e.key === 'X' where X is a single char
 */
const INLINE_MATCHER_PATTERN =
  /(?<![!|(])e\.(metaKey|ctrlKey)\b.{0,80}\be\.key\s*===?\s*['"][a-zA-Z0-9,./;\\]['"]/

/**
 * Reverse pattern: e.key check followed by a POSITIVE modifier.
 */
const INLINE_MATCHER_PATTERN_REVERSED =
  /\be\.key\s*===?\s*['"][a-zA-Z0-9,./;\\]['"].{0,80}(?<![!|(])e\.(metaKey|ctrlKey)\b/

describe('Keybindings registry — single source of truth', () => {
  it('admin/ files do not contain inline key-combo matchers (metaKey/ctrlKey+letter) outside the allowlist', () => {
    const files = collectTsFiles(ADMIN_SRC)
    const violations: string[] = []

    for (const file of files) {
      const rel = relative(SRC_ROOT, file)
      if (ALLOWLIST.has(rel)) continue

      const rawSource = readFileSync(file, 'utf8')
      // Check line by line to avoid cross-line false positives and skip comment lines.
      const lines = rawSource.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()

        // Skip comment-only lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

        if (INLINE_MATCHER_PATTERN.test(line) || INLINE_MATCHER_PATTERN_REVERSED.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`)
          break // one violation per file is enough
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[keybindings-registry] Inline key-combo matchers found outside the registry.\n' +
          'Add your shortcut to src/admin/spotlight/keybindings.ts and use\n' +
          'getKeybindingForCommand(commandId).match(e) in the handler instead.\n\n' +
          violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('admin/ TSX files do not render hand-written ⌘/⌃/⌥/⇧ shortcut symbols outside the allowlist', () => {
    const files = collectTsFiles(ADMIN_SRC)
    const violations: string[] = []

    // Pattern: modifier symbol inside what looks like JSX text content or a
    // JSX attribute string value. We only check .tsx files (not .ts logic files).
    //
    // Match: a modifier symbol appearing in a JSX attribute value or text content:
    //   tooltip="Save (⌘S)"         → should flag
    //   <span>⌘S</span>             → should flag
    //   // comment with ⌘K          → should NOT flag (comment line)
    //   * JSDoc with ⌘K             → should NOT flag (comment line)
    const SHORTCUT_SYMBOL_RE = /[⌘⌥⌃⇧]/

    for (const file of files) {
      if (!file.endsWith('.tsx')) continue

      const rel = relative(SRC_ROOT, file)
      if (ALLOWLIST.has(rel)) continue

      const lines = readFileSync(file, 'utf8').split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()

        // Skip comment-only lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

        if (SHORTCUT_SYMBOL_RE.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`)
          break
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[keybindings-registry] Hand-written shortcut symbols (⌘, ⌃, ⌥, ⇧) found in TSX outside renderers.\n' +
          'Use formatShortcut(getKeybindingForCommand(id).shortcut)\n' +
          'to get the platform-aware label from the registry.\n\n' +
          violations.map((v) => `  ${v}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
