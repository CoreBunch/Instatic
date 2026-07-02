/**
 * Architecture Gate — Module size budgets
 *
 * Caps the line count of individual source modules. The codebase already
 * gates structure exhaustively (import boundaries, design tokens, DB dialect
 * parity, primitive usage, bundle size). The one dimension nothing gated was
 * *mass*: structure stayed clean while individual modules silently grew into
 * 1000-line god-files — exactly the modules where every feature lands, where
 * parallel sessions collide, and where bugs hide.
 *
 * This gate closes that gap. It is the per-module sibling of
 * `bundle-size-budgets.test.ts`: a static cap that catches the
 * silent-regression case, plus a grandfathered ledger of the modules that
 * were already over the line when the gate landed.
 *
 * Two mechanisms
 * --------------
 * 1. CEILING — no NEW source module may exceed {@link CEILING} lines. A file
 *    that crosses it is a god-file being born; split it by responsibility
 *    before it calcifies. (If a new module genuinely cannot be split — a
 *    generated table, an exhaustive switch — add it to GRANDFATHERED with a
 *    one-line justification, same as raising a bundle cap.)
 *
 * 2. GRANDFATHERED — the modules already over CEILING when this gate landed,
 *    each frozen at its current size. This is a **ratchet, not a freeze**:
 *      - a grandfathered file may shrink freely but MUST NOT grow past its
 *        recorded cap (adding lines forces you to extract first);
 *      - when it shrinks by more than {@link RATCHET_SLACK} lines below its
 *        cap, the gate fails asking you to lower the recorded number — so the
 *        ratchet actually tightens over time instead of leaking;
 *      - once it drops to CEILING or below, the gate fails asking you to
 *        delete its entry entirely (it has graduated and is now held by the
 *        normal CEILING rule).
 *
 * Why line count, not cyclomatic complexity
 * -----------------------------------------
 * Line count is the honest, unambiguous, zero-dependency proxy. It needs no
 * AST, never disagrees with `wc -l`, and a 1000-line module is a problem
 * regardless of how branchy it is. A cyclomatic-complexity gate is a fine
 * future addition — it would live in a sibling file — but this gate
 * deliberately measures the thing it can measure without interpretation.
 *
 * Append-only ledgers are exempt
 * ------------------------------
 * The two migration files grow by design — CLAUDE.md mandates appending a
 * new migration to BOTH on every schema change. Capping them would punish
 * correct behavior, so they are exempt entirely rather than grandfathered.
 *
 * Counting convention
 * -------------------
 * Lines == number of newline characters in the file, identical to `wc -l`.
 * The recorded caps below were captured with `wc -l`.
 *
 * @see bundle-size-budgets.test.ts — sibling gate (output size, not source size)
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')

/** Directories (relative to repo root) whose `.ts`/`.tsx` modules are gated. */
const SCAN_ROOTS = ['src', 'server'] as const

/** Maximum lines for any source module not on the grandfathered ledger. */
const CEILING = 700

/**
 * How far below its recorded cap a grandfathered file must shrink before the
 * gate insists you lower the number. Big enough to ignore incidental ±line
 * churn, small enough that a real extraction tightens the ratchet.
 */
const RATCHET_SLACK = 30

/**
 * Append-only ledgers — grow by design, exempt from the cap entirely.
 * (CLAUDE.md: every schema change appends a migration to BOTH files.)
 */
const EXEMPT = new Set<string>([
  'server/db/migrations-pg.ts',
  'server/db/migrations-sqlite.ts',
])

/**
 * Grandfathered hotspots: modules already over {@link CEILING} when this gate
 * landed, frozen at their current line count. Ratchet DOWN only — see the
 * file header for the rules. Captured via `wc -l` on 2026-05-31.
 *
 * Every entry here is a known debt. The healthy direction for this map is
 * shorter; the goal is an empty object.
 */
const GRANDFATHERED: Record<string, number> = {
  'src/admin/pages/site/store/slices/visualComponentsSlice.ts': 715,
  // server/repositories/media.ts graduated: the row ↔ asset mapping unit was
  // extracted into server/repositories/mediaAssetMapping.ts, dropping media.ts
  // to 583 lines — under CEILING, so it's now held by the normal ceiling rule.
  'server/handlers/cms/auth.ts': 854,
  // src/core/loops/sources/dataRows.ts graduated: the 12 per-order-branch SQL
  // copies collapsed into one query + a whitelisted ORDER BY column map,
  // dropping the file to 540 lines — under CEILING, so it's now held by the
  // normal ceiling rule.
  // The O(1) parentId pointer is a denormalised cache that every
  // parentage-changing primitive (insert/move/duplicate/wrap/paste) maintains
  // inline. The node deep-clone primitive lives in its own module
  // (cloneNode.ts) so the three duplicate/paste/duplicatePage callers share one
  // clone. See docs/reference/page-tree.md (parentId).
  // Ratcheted 880 → 760 when the page-roster mutations moved to pageMutations.ts.
  'src/core/page-tree/mutations.ts': 760,
  // server/plugins/host/handlers/content.ts graduated (786 → 661) when the
  // DB→wire projection helpers moved to contentProjection.ts.
  'src/core/siteImport/cssToStyleRules.ts': 708,
  'src/admin/pages/site/panels/TypographyPanel/FontsSection/AddGoogleFontDialog.tsx': 751,
  'src/core/markdown/markdownDocument.ts': 748,
  'src/admin/pages/dashboard/DashboardPage.tsx': 732,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect gated `.ts`/`.tsx` modules under a root, repo-relative. */
function collectModules(absRoot: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        // Test code is exercised by other gates and is allowed to be long
        // (large fixture-heavy suites); this gate targets shipped modules.
        if (entry === '__tests__' || entry === 'node_modules') continue
        walk(abs)
        continue
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue
      out.push(relative(REPO_ROOT, abs).split(sep).join('/'))
    }
  }
  walk(absRoot)
  return out
}

/** Line count identical to `wc -l`: the number of newline characters. */
function lineCount(repoRelPath: string): number {
  const content = readFileSync(join(REPO_ROOT, repoRelPath), 'utf8')
  let n = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) n++
  }
  return n
}

const ALL_MODULES = SCAN_ROOTS.flatMap((root) =>
  collectModules(join(REPO_ROOT, root)),
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Module size budgets', () => {
  it('no new module exceeds the ceiling', () => {
    const offenders = ALL_MODULES.filter(
      (path) =>
        !EXEMPT.has(path) &&
        !(path in GRANDFATHERED) &&
        lineCount(path) > CEILING,
    ).map((path) => `${path} (${lineCount(path)} lines)`)

    if (offenders.length > 0) {
      throw new Error(
        `[module-size-budgets] ${offenders.length} module(s) exceed the ` +
          `${CEILING}-line ceiling:\n` +
          offenders.map((o) => `  - ${o}`).join('\n') +
          `\n\nA module this large is a god-file. Split it by responsibility ` +
          `(extract a slice, a sub-panel, a helper module). If it genuinely ` +
          `cannot be split, add it to GRANDFATHERED in this file with a ` +
          `one-line justification — the same escape hatch as raising a ` +
          `bundle-size cap.`,
      )
    }
    expect(offenders).toEqual([])
  })

  it('grandfathered modules do not grow past their recorded cap', () => {
    const grown = Object.entries(GRANDFATHERED)
      .filter(([path]) => ALL_MODULES.includes(path))
      .map(([path, cap]) => ({ path, cap, actual: lineCount(path) }))
      .filter(({ cap, actual }) => actual > cap)

    if (grown.length > 0) {
      throw new Error(
        `[module-size-budgets] ${grown.length} grandfathered module(s) grew ` +
          `past their recorded cap:\n` +
          grown
            .map((g) => `  - ${g.path}: ${g.actual} lines (cap ${g.cap})`)
            .join('\n') +
          `\n\nThese files are known debt and may only shrink. Extract the ` +
          `new code into its own module instead of adding lines here.`,
      )
    }
    expect(grown).toEqual([])
  })

  it('grandfathered caps stay tight (ratchet down as files shrink)', () => {
    const loosened = Object.entries(GRANDFATHERED)
      .filter(([path]) => ALL_MODULES.includes(path))
      .map(([path, cap]) => ({ path, cap, actual: lineCount(path) }))
      .filter(({ actual }) => actual > CEILING) // graduated ones handled below
      .filter(({ cap, actual }) => actual <= cap - RATCHET_SLACK)

    if (loosened.length > 0) {
      throw new Error(
        `[module-size-budgets] ${loosened.length} grandfathered cap(s) are ` +
          `now loose — the file shrank but its recorded cap did not:\n` +
          loosened
            .map((g) => `  - ${g.path}: now ${g.actual} lines, lower cap to ${g.actual}`)
            .join('\n') +
          `\n\nLower each recorded number to the current line count so the ` +
          `ratchet holds the win (otherwise the file could silently re-grow).`,
      )
    }
    expect(loosened).toEqual([])
  })

  it('graduated modules are removed from the grandfathered ledger', () => {
    const graduated = Object.entries(GRANDFATHERED)
      .filter(([path]) => ALL_MODULES.includes(path))
      .filter(([path]) => lineCount(path) <= CEILING)
      .map(([path]) => `${path} (${lineCount(path)} lines)`)

    if (graduated.length > 0) {
      throw new Error(
        `[module-size-budgets] ${graduated.length} grandfathered module(s) ` +
          `are now at or under the ${CEILING}-line ceiling:\n` +
          graduated.map((g) => `  - ${g}`).join('\n') +
          `\n\nDelete their entries from GRANDFATHERED — they are held by the ` +
          `normal ceiling rule now. Every removal is the gate working.`,
      )
    }
    expect(graduated).toEqual([])
  })

  it('the grandfathered ledger has no stale entries', () => {
    const stale = Object.keys(GRANDFATHERED).filter(
      (path) => !ALL_MODULES.includes(path),
    )

    if (stale.length > 0) {
      throw new Error(
        `[module-size-budgets] ${stale.length} grandfathered entr(ies) point ` +
          `at modules that no longer exist (moved or deleted):\n` +
          stale.map((p) => `  - ${p}`).join('\n') +
          `\n\nRemove or repath these entries.`,
      )
    }
    expect(stale).toEqual([])
  })
})
