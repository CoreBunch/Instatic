/**
 * Architecture gate — no native HTML `title=` attribute on interactive elements.
 *
 * Interactive elements (<Button>, <button>) in src/admin/ and src/admin/pages/site/ MUST
 * use the Tooltip primitive for hover hints — either via Button's `tooltip=`
 * prop or via a direct <Tooltip> wrapper — rather than the native HTML
 * `title=` attribute, which renders a native OS tooltip with no styling control.
 *
 * What is and is NOT a violation
 * ────────────────────────────────
 * VIOLATION:
 *   <Button ... title="Undo (⌘Z)" />   ← should be tooltip="Undo (⌘Z)"
 *   <button ... title="Refresh" />      ← should wrap with <Tooltip>
 *
 * NOT a violation:
 *   <PanelHeader title="Properties" />  ← component-level string prop, not HTML attribute
 *   <iframe title="Preview" />          ← required accessible name for iframes
 *   <span title={name} />               ← non-interactive overflow-truncation affordance
 *
 * The scanner detects `title=` inside the opening-tag attribute block of every
 * <Button or <button element. It respects {…} expression nesting so comparisons
 * like `onClick={() => a > b}` never cause false `>` termination.
 *
 * ALLOWLIST contains the ONLY non-interactive elements permitted to keep a
 * `title=` attribute. Each entry must have a written justification.
 * These are static display elements (spans, divs) used for overflow truncation
 * or as aria-hidden decorative indicators — they have no onClick and carry
 * no role="button", so the scanner naturally skips them. The allowlist exists
 * solely for documentation; adding a new interactive element with `title=`
 * and no allowlist entry is what fails the test.
 *
 * @see src/ui/components/Tooltip/Tooltip.tsx — Tooltip primitive
 * @see src/ui/components/Button/Button.tsx    — Button with tooltip= prop
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { extname, join, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const SCAN_ROOTS = [join(SRC_ROOT, 'admin'), join(SRC_ROOT, 'editor')]

// ─── Allowlist ─────────────────────────────────────────────────────────────────
// Non-interactive elements that legitimately keep native `title=`.
// These are excluded from the scan because none of them are <Button or <button,
// but they are documented here as the intended set of approved exceptions.

export const ALLOWED_NATIVE_TITLES: Array<{
  file: string
  reason: string
}> = [
  {
    file: 'admin/pages/site/canvas/NodeRenderer.tsx',
    reason:
      'Non-interactive <div title="Unknown module: …"> error-display panel. ' +
      'Not a button — no onClick, no role="button".',
  },
  {
    file: 'admin/pages/site/panels/DomPanel/LayerTreeNodeContent.tsx',
    reason:
      'aria-hidden="true" emoji lock/visibility indicators: <span title="Locked"> and ' +
      '<span title="Hidden">. Adding aria-label to an aria-hidden element is ignored by AT; ' +
      'title= is the only way to give sighted users a hover label here.',
  },
  {
    file: 'admin/pages/site/panels/DependenciesPanel/DepsSection.tsx',
    reason:
      'Three non-interactive display spans: truncated dep name (<span title={name}>), ' +
      'locked-version badge (<span title="Locked at …">), and usage badge ' +
      '(<span title="Required by …">). All are display-only, no onClick.',
  },
  {
    file: 'admin/pages/site/panels/PropertiesPanel/ComponentRefView.tsx',
    reason:
      'Truncated parameter name label (<span title={param.name}>) — non-interactive display.',
  },
  {
    file: 'admin/pages/site/panels/PropertiesPanel/PropertiesPanel.tsx',
    reason:
      'Truncated element/selector name labels (<span title={displayName}>, ' +
      '<span title={selectorLabel}>) — non-interactive display spans used for text-overflow.',
  },
  {
    file: 'admin/pages/site/property-controls/MediaLibraryControl.tsx',
    reason:
      'Truncated media path (<div title={currentAsset.publicPath}>) — non-interactive display.',
  },
]

// ─── File collection ───────────────────────────────────────────────────────────

function collectTSXFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) results.push(...collectTSXFiles(full))
    else if (extname(entry) === '.tsx') results.push(full)
  }
  return results
}

// ─── Violation scanner ─────────────────────────────────────────────────────────

interface Violation {
  rel: string
  line: number
  element: string
}

/**
 * Scans the source for `title=` attributes inside the opening-tag block of
 * every <Button or <button element.
 *
 * Algorithm:
 *  1. Find each `<Button` or `<button` start in the source.
 *  2. Walk forward character by character, tracking `{…}` depth.
 *  3. Stop when the opening tag closes at `>` or `/>` (only at depth === 0).
 *  4. If `title=` (with no further identifier character) appears before the
 *     close at depth 0, record a violation.
 */
function findViolations(source: string, rel: string): Violation[] {
  const violations: Violation[] = []
  const opener = /<[Bb]utton\b/g
  let m: RegExpExecArray | null

  while ((m = opener.exec(source)) !== null) {
    const elementName = source[m.index + 1] === 'B' ? 'Button' : 'button'
    const tagStart = m.index
    let pos = tagStart + m[0].length
    let depth = 0
    let titleLine = -1

    while (pos < source.length) {
      const ch = source[pos]

      if (ch === '{') {
        depth++
        pos++
        continue
      }
      if (ch === '}') {
        depth--
        pos++
        continue
      }

      if (depth === 0) {
        // Closing of the opening tag at depth 0
        if (ch === '>' || (ch === '/' && source[pos + 1] === '>')) {
          break
        }

        // Look for the word `title` followed immediately by `=`
        // (and not a longer identifier like `titleContent=`).
        if (
          source.slice(pos, pos + 5) === 'title' &&
          /[\s=]/.test(source[pos + 5] ?? '') &&
          /^\s*=/.test(source.slice(pos + 5))
        ) {
          titleLine = source.slice(0, pos).split('\n').length
        }
      }

      pos++
    }

    if (titleLine !== -1) {
      violations.push({ rel, line: titleLine, element: elementName })
    }
  }

  return violations
}

// ─── Test ──────────────────────────────────────────────────────────────────────

describe('Architecture — no native title= on interactive elements', () => {
  it('no <Button or <button carries a title= attribute in src/admin and src/admin/pages/site', () => {
    const files = SCAN_ROOTS.flatMap((root) => collectTSXFiles(root))
    const allViolations: Violation[] = []

    for (const file of files) {
      const rel = relative(SRC_ROOT, file)
      const source = readFileSync(file, 'utf8')
      const violations = findViolations(source, rel)
      allViolations.push(...violations)
    }

    if (allViolations.length > 0) {
      const lines = allViolations.map(
        (v) => `  ${v.rel}:${v.line}  [<${v.element}> has title= — use tooltip= or <Tooltip>]`,
      )
      throw new Error(
        `[no-native-title-tooltips] Native title= attribute found on interactive elements.\n` +
          `Replace with Button's tooltip= prop or wrap with <Tooltip content="…">.\n\n` +
          lines.join('\n'),
      )
    }

    expect(allViolations).toHaveLength(0)
  })
})
