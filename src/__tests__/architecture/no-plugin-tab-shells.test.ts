/**
 * Architecture Source-Scan — Tab-Shell Regression Gate
 *
 * Host admin/editor code must use the Tabs compound component from
 * @instatic/host-ui (src/ui/components/Tabs/) for any tab UI. Rolling a
 * custom `role="tablist"` div is banned outside the primitive itself and a
 * small set of pre-existing §T-allowlisted files.
 *
 * SCAN ROOTS:
 *   src/admin/**                    — host admin shell
 *   src/editor/**                   — host editor shell
 *
 * ALLOWLIST (§T-coded):
 *   §T.0  src/ui/components/Tabs/   — the Tabs primitive itself; role="tablist"
 *                                     is its entire job.
 *   §T.1  src/admin/pages/users/UsersPage.tsx — pre-existing custom tablist;
 *         uses a capability-gated Button row built before the Tabs compound
 *         component was introduced.
 *   §T.2  src/admin/pages/account/AccountPage.tsx — same pre-existing pattern
 *         as §T.1.
 *   §T.3  src/admin/pages/site/canvas/CanvasModeToggle.tsx — design/preview
 *         segmented-control with icon-only tab buttons; predates the Tabs
 *         primitive and uses its own compact CSS layout.
 *   §T.4  src/admin/pages/content/components/ContentModeToggle/ContentModeToggle.tsx
 *         — Write/Live segmented-control for the content workspace, mirroring
 *         the §T.3 icon-only segmented-pill pattern.
 *
 * Any new file outside the allowlist that introduces role="tablist" fails this
 * test. Fix: use <Tabs> / <TabList> from @instatic/host-ui instead of a
 * hand-rolled tablist.
 *
 * @see src/ui/components/Tabs/Tabs.tsx — the compound component to use
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const SRC_ROOT = join(PROJECT_ROOT, 'src')

// ---------------------------------------------------------------------------
// File walker — .ts and .tsx files only, recursive
// ---------------------------------------------------------------------------

function walkTSX(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkTSX(full, out)
    } else {
      const ext = extname(entry)
      if (ext === '.tsx' || ext === '.ts') out.push(full)
    }
  }
  return out
}

function collectAllFiles(): string[] {
  return [
    ...walkTSX(join(SRC_ROOT, 'admin')),
    ...walkTSX(join(SRC_ROOT, 'editor')),
  ]
}

// ---------------------------------------------------------------------------
// Allowlist — files that are explicitly exempt from this gate
// ---------------------------------------------------------------------------

/** §T.0 — every file under the Tabs primitive directory is allowed. */
const TABS_PRIMITIVE_DIR = join(PROJECT_ROOT, 'src/ui/components/Tabs')

/** §T.1–§T.4 — pre-existing custom tablist implementations. */
const EXACT_ALLOWLIST = new Set<string>([
  // §T.1 — capability-gated Button row in UsersPage predates the Tabs primitive.
  join(PROJECT_ROOT, 'src/admin/pages/users/UsersPage.tsx'),
  // §T.2 — same pre-existing pattern in AccountPage.
  join(PROJECT_ROOT, 'src/admin/pages/account/AccountPage.tsx'),
  // §T.3 — icon-only design/preview toggle; compact fixed layout incompatible
  // with the full-width underline-indicator Tabs style.
  join(PROJECT_ROOT, 'src/admin/pages/site/canvas/CanvasModeToggle.tsx'),
  // §T.4 — Content workspace's Write/Live mode switch mirrors the §T.3
  // pattern: icon-only, compact fixed layout that the full-width Tabs
  // style cannot represent.
  join(PROJECT_ROOT, 'src/admin/pages/content/components/ContentModeToggle/ContentModeToggle.tsx'),
])

function isAllowlisted(file: string): boolean {
  if (file.startsWith(TABS_PRIMITIVE_DIR + '/') || file === TABS_PRIMITIVE_DIR) return true
  return EXACT_ALLOWLIST.has(file)
}

// ---------------------------------------------------------------------------
// Comment stripper — preserves line numbers by replacing non-newline chars
// ---------------------------------------------------------------------------

const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm

function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
}

// ---------------------------------------------------------------------------
// Violation detection — role="tablist" or role='tablist' in live code
// ---------------------------------------------------------------------------

const TABLIST_RE = /role\s*=\s*["']tablist["']/

interface Violation {
  file: string
  line: number
  text: string
}

function scanForViolations(): Violation[] {
  const violations: Violation[] = []

  for (const file of collectAllFiles()) {
    if (isAllowlisted(file)) continue

    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const stripped = stripComments(content)
    const lines = stripped.split('\n')

    for (let i = 0; i < lines.length; i++) {
      if (TABLIST_RE.test(lines[i])) {
        violations.push({
          file: relative(PROJECT_ROOT, file),
          line: i + 1,
          text: lines[i].trim(),
        })
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('No-plugin-tab-shells — role="tablist" must come from the Tabs primitive', () => {
  it('scan roots resolve to at least one file (sanity check)', () => {
    const files = collectAllFiles()
    expect(files.length).toBeGreaterThan(0)
  })

  it('no file outside the allowlist contains role="tablist" directly', () => {
    const violations = scanForViolations()

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }

    const lines = violations.map(
      (v) =>
        `  ${v.file}:${v.line}\n` +
        `    ${v.text}`,
    )

    throw new Error(
      `[no-plugin-tab-shells] ${violations.length} file(s) contain role="tablist" outside the allowlist.\n` +
        `Use <Tabs> / <TabList> from @instatic/host-ui instead of a hand-rolled tablist.\n\n` +
        `Violations:\n` +
        lines.join('\n') +
        `\n\n§T-allowlisted files (role="tablist" is acceptable there):\n` +
        `  src/ui/components/Tabs/   (§T.0 — the primitive itself)\n` +
        `  src/admin/pages/users/UsersPage.tsx   (§T.1)\n` +
        `  src/admin/pages/account/AccountPage.tsx   (§T.2)\n` +
        `  src/admin/pages/site/canvas/CanvasModeToggle.tsx   (§T.3)\n` +
        `  src/admin/pages/content/components/ContentModeToggle/ContentModeToggle.tsx   (§T.4)`,
    )
  })
})
