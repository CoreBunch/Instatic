/**
 * Architecture Source-Scan — Close Icon Correctness
 *
 * Enforces that no production component imports `XIcon` (the X/Twitter logo)
 * as a close or dismiss button.
 *
 * ## Background
 *
 * `XIcon` renders the X (formerly Twitter) logo from the MotionPageMaster icon
 * set. It was mistakenly used as a close/dismiss icon in several modal and
 * overlay components before this gate was introduced.
 *
 * The correct close icon for dialogs, modals, and panel headers is:
 *
 *   import { CloseIcon } from 'pixel-art-icons/icons/close'
 *   <CloseIcon size={12} color="currentColor" aria-hidden="true" />
 *
 * This pattern is codified in `PanelHeader.tsx` and is the site-wide standard
 * (user directive, msg #1967 / Contribution #649).
 *
 * ## What this test checks
 *
 * 1. No production file imports `pixel-art-icons/icons/x` anywhere (catches future
 *    regression regardless of context — the X/Twitter icon has no legitimate
 *    close-button use case in this codebase).
 *
 * ## Legitimate X-shaped icon patterns that ARE allowed
 *
 * - `<CloseIcon ...>` — the canonical site close icon
 * - `x-circle` / `x-square` icon files — distinct icon names
 * - Status icons with aria meaning (e.g. error state) — those use different
 *   icon names (`circle-x`, `alert-circle`, etc.)
 *
 * @see PanelHeader.tsx — canonical close button reference implementation
 * @see Guideline #350 — pixel-art-icons accessibility requirements
 * @see User directive msg #1967 — Fix X logo used as close icon
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')

// ---------------------------------------------------------------------------
// File walker (same pattern as no-third-party-icons.test.ts)
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

// Scan production source only — not __tests__ (test files contain the banned
// pattern as regex strings and would false-positive).
const PROD_DIRS = ['admin', 'core', 'modules', 'ui'].map((d) => join(SRC_ROOT, d))

function collectProdFiles(): string[] {
  for (const dir of PROD_DIRS) {
    if (!existsSync(dir)) {
      throw new Error(
        `Scan root missing: ${dir} — update PROD_DIRS to the directories that exist under src/.`
      )
    }
  }
  return PROD_DIRS.flatMap((dir) => collectFiles(dir))
}

// ---------------------------------------------------------------------------
// Banned pattern — XIcon (X/Twitter logo used as close button)
// ---------------------------------------------------------------------------

// NOTE: String is split so that THIS test file does not self-match.
const X_LOGO_PATTERN = new RegExp(`from\\s+["']pixel-art-icons/icons/` + `x["']|<` + `XIcon\\b`)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Close-icon correctness — no X/Twitter logo used as close button', () => {
  it('CI-1: no production file imports XIcon (X/Twitter logo as close icon)', () => {
    const allFiles = collectProdFiles()

    const violations = allFiles.filter((f) => {
      try {
        return X_LOGO_PATTERN.test(readFileSync(f, 'utf8'))
      } catch {
        return false
      }
    })

    if (violations.length > 0) {
      const rel = violations.map((f) => f.replace(SRC_ROOT, 'src/'))
      throw new Error(
        [
          '[CI-1] XIcon (X/Twitter logo) found in production source.',
          '',
          'Use the site-standard close icon instead:',
          '',
          "  import { CloseIcon } from 'pixel-art-icons/icons/close'",
          '  <CloseIcon size={12} color="currentColor" aria-hidden="true" />',
          '',
          'See PanelHeader.tsx for the canonical reference implementation.',
          '',
          'Violating files:',
          ...rel.map((f) => `  ${f}`),
        ].join('\n')
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('CI-2: shared Dialog primitive owns the close button and uses CloseIcon', () => {
    // The Dialog primitive in src/ui/components/Dialog/ is the single owner
    // of the close button across every dialog in the admin app
    // (ConfirmDeleteDialog, SiteCreateDialog, FrameworkChangeConfirmDialog,
    // PluginSettingsDialog, PluginRemoveDialog all compose <Dialog/>).
    // Validating it once here covers every consumer transitively — they
    // can no longer drift onto a wrong close icon.
    const dialogPath = join(SRC_ROOT, 'ui/components/Dialog/Dialog.tsx')
    let src: string
    try {
      src = readFileSync(dialogPath, 'utf8')
    } catch {
      throw new Error(`[CI-2] Dialog primitive not found at expected path: ${dialogPath}`)
    }

    // Must import CloseIcon
    expect(src).toMatch(/import\s*\{[^}]*CloseIcon[^}]*\}\s*from\s*['"]pixel-art-icons\/icons\/close['"]/)

    // Must NOT use XIcon
    expect(src).not.toMatch(X_LOGO_PATTERN)

    // Must use CloseIcon in JSX
    expect(src).toMatch(/<CloseIcon\b/)
  })

  it('CI-3: SettingsModal closes via the shared Esc keycap (no X/Twitter close icon)', () => {
    // The Settings modal shares the Spotlight / Module Inserter language:
    // backdrop click + Esc both close, surfaced through a <Kbd>Esc</Kbd> hint.
    // There is no dedicated close-icon button — so the only requirement is that
    // it never reaches for an X/Twitter glyph as a close affordance.
    const modalPath = join(SRC_ROOT, 'admin/modals/Settings/SettingsModal.tsx')
    let src: string
    try {
      src = readFileSync(modalPath, 'utf8')
    } catch {
      throw new Error(`[CI-3] SettingsModal.tsx not found at expected path: ${modalPath}`)
    }

    expect(src).not.toMatch(X_LOGO_PATTERN)
    expect(src).toContain('<Kbd>Esc</Kbd>')
  })

  it('CI-4: PreviewOverlay close button uses CloseIcon from pixel-art-icons/icons/close', () => {
    const overlayPath = join(SRC_ROOT, 'admin/pages/site/preview/PreviewOverlay.tsx')
    let src: string
    try {
      src = readFileSync(overlayPath, 'utf8')
    } catch {
      throw new Error(`[CI-4] PreviewOverlay.tsx not found at expected path: ${overlayPath}`)
    }

    expect(src).toMatch(/import\s*\{[^}]*CloseIcon[^}]*\}\s*from\s*['"]pixel-art-icons\/icons\/close['"]/)
    expect(src).not.toMatch(X_LOGO_PATTERN)
    expect(src).toMatch(/<CloseIcon\b/)
  })
})
