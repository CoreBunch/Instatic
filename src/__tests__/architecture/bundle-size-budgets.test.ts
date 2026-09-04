/**
 * Architecture Gate — Bundle size budgets
 *
 * Locks in the production bundle sizes that the editor's first-paint cost
 * depends on. A static cap per chunk catches the silent-regression case
 * where a refactor pulls a heavy dependency into the eager admin graph
 * (e.g. a stray `import { EditorView } from '@codemirror/view'` in an
 * eager file, or a sidebar control hoisting the entire properties panel
 * into a sibling chunk).
 *
 * Why these chunks
 * ----------------
 * `index` and `react-vendor` are downloaded on **every** admin first paint
 * — they are the cost of opening any /admin route. `cmsAuth` is the narrow
 * pre-auth client; it deliberately replaced the old full persistence barrel
 * on startup. `validation-vendor` is still eager because boot responses use
 * TypeBox. `dnd-vendor` is explicitly budgeted as a lazy Site-editor vendor
 * chunk so React startup cannot accidentally depend on it again.
 *
 * `CodeMirrorEditor` is the heaviest lazy chunk and the most attractive
 * target for regression (a single static import unifies it with `index`
 * — the codemirror-lazy-only gate prevents that *path*, this gate
 * prevents the *size* from growing unnoticed).
 *
 * Why static byte caps rather than diff-against-baseline
 * ------------------------------------------------------
 * A diff approach would need a stored baseline file in the repo, which
 * thrashes on every PR. A static cap with ~5–10% headroom over the
 * current size gives a clear "you broke the bundle" signal without
 * spurious churn. When a chunk is *intentionally* reduced (e.g. lifting
 * the editor store out of AdminPageLayout), lower the cap in the same PR
 * — that's a one-line change that documents the win.
 *
 * Build artefact discovery
 * ------------------------
 * Vite emits hashed names: `layouts-CSneVf19.js`. We match by stable
 * prefix (`layouts-`) and resolve the hashed filename at test time.
 *
 * Dev workflow note
 * -----------------
 * `dist/assets/` only exists after `bun run build`. When dist is absent
 * the gate self-skips with a console warning rather than failing — the
 * canonical way to run this gate is `bun run test:bundle`, which builds
 * first. In CI, the build step is mandatory before tests, so the gate
 * is always active there.
 *
 * @see vite.config.ts — vendor chunk groups (long-term cache strategy)
 * @see codemirror-lazy-only.test.ts — sibling gate (lazy boundary protection)
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, statSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const DIST_ASSETS = join(REPO_ROOT, 'dist/assets')
const VENDORED_ICON_DIST = join(REPO_ROOT, 'vendor/pixel-art-icons/dist/icons')

interface ChunkBudget {
  /** Stable prefix of the chunk filename (Vite appends `-<hash>.js`). */
  prefix: string
  /** Maximum allowed size in bytes (raw, post-minify, pre-gzip). */
  maxBytes: number
  /** One-line note explaining the budget and current size. */
  rationale: string
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
//
// Sizes captured from `bun run build` (rolldown, production mode).
// Each cap allows ~7-10% headroom over current — enough to absorb a small
// refactor without spurious failures, tight enough to catch a real
// regression. Update caps DOWN when a chunk is intentionally shrunk.
// ---------------------------------------------------------------------------
const BUDGETS: ChunkBudget[] = [
  // Top-level eager chunks (loaded on every /admin first paint).
  {
    prefix: 'index-',
    maxBytes: 40_000,
    rationale: 'admin entry chunk (current ~25 KB raw / 9 KB gzipped)',
  },
  {
    prefix: 'react-vendor-',
    maxBytes: 200_000,
    rationale: 'react + react-dom (current ~187 KB raw / 59 KB gzipped)',
  },
  {
    prefix: 'validation-vendor-',
    maxBytes: 125_000,
    rationale:
      '@sinclair/typebox value + compiler helpers for hot validation ' +
      '(current ~116 KB raw / 29 KB gzipped)',
  },
  {
    prefix: 'dnd-vendor-',
    maxBytes: 80_000,
    rationale: '@dnd-kit/core + @use-gesture lazy editor vendor (current ~70 KB raw / 22 KB gzipped)',
  },
  {
    prefix: 'state-vendor-',
    maxBytes: 46_000,
    rationale: 'dompurify + mutative + zustand-mutative (current ~42 KB raw / 15 KB gzipped)',
  },
  {
    prefix: 'pixel-art-icons-',
    maxBytes: 90_000,
    rationale:
      'single tree-shaken chunk for imported vendored pixel-art-icons ' +
      '(current ~50 KB raw / ~9 KB gzipped). Must not regress into ' +
      'one emitted chunk per icon.',
  },

  {
    prefix: 'cmsAuth-',
    maxBytes: 10_000,
    rationale: 'narrow admin boot/auth client (current ~7 KB raw / 2 KB gzipped)',
  },

  // Site editor — the route chunk must stay the real shell only. The heavy
  // canvas/panels/modules graph lives in AdminCanvasEditorBody so /admin/site
  // can paint the existing toolbar/chrome before the editor body downloads.
  {
    prefix: 'SitePage-',
    // Raised from 30 KB when site branches landed: the publish gate (disabled
    // with the inline reason on a branch), the version-history entry, and the
    // per-branch persistence hook are part of the shell by design (~+1 KB raw).
    // Raised again for site plugins: the `plugins.edit` gate, the Plugin IDE
    // route and workspace entry (~+0.8 KB raw). The editor body still lands in
    // its own chunk — the shell carries no DnD, canvas, or module code.
    maxBytes: 33_500,
    rationale:
      'site route shell (current ~32 KB raw / ~10 KB gzipped). Must not ' +
      'pull the visual editor body, DnD, canvas, first-party modules, or ' +
      'PropertiesPanel back into the active route chunk.',
  },
  {
    prefix: 'AdminCanvasEditorBody-',
    maxBytes: 780_000,
    rationale:
      'post-paint Site editor body (canvas + panels + modules + publisher). ' +
      'Current ~724 KB raw / ~228 KB gzipped after moving Import HTML behind ' +
      'its own open-state lazy boundary. This is still the main Site runtime ' +
      'cost, but it must remain behind the shell lazy boundary.',
  },
  {
    prefix: 'ImportHtml-',
    maxBytes: 12_000,
    rationale:
      'rarely opened Import HTML modal chunk (current ~9 KB raw / ~4 KB ' +
      'gzipped). Must stay behind the modal open-state lazy boundary.',
  },

  {
    prefix: 'AdminWorkspaceCanvasLayout-',
    maxBytes: 10_000,
    rationale:
      'non-site canvas shell for Content/Data/Media. Current ~6 KB raw / ' +
      '~3 KB gzipped. Must not import Site canvas, PropertiesPanel, DnD, ' +
      'CodeMirror, or import wizards.',
  },

  {
    prefix: 'ContentPage-',
    maxBytes: 100_000,
    rationale:
      'content workspace route after Tiptap/LiveCanvas lazy split and shared ' +
      'data-binding picker adoption, including the role editor safeguards that ' +
      'keep Owner-only capabilities visible but non-selectable. Current ~91 KB raw / ~31 KB gzipped.',
  },

  {
    prefix: 'MediaNodeToolbar-',
    maxBytes: 530_000,
    rationale:
      'lazy Tiptap/ProseMirror editor support chunk. Current ~492 KB raw / ' +
      '~154 KB gzipped; loaded only when the content body editor/live editor mounts.',
  },

  // Admin shell — the lightweight layout for non-canvas admin pages.
  // Must stay TINY: every byte added here ships on every non-editor admin
  // page (Plugins / Users / Account / plugin admin pages).
  {
    prefix: 'AdminPageLayout-',
    maxBytes: 12_000,
    rationale:
      'lightweight admin shell — toolbar + page header + settings modal ' +
      'mount gate. Current ~6 KB raw / 3 KB gzipped. Reads adminUi (tiny ' +
      'Zustand store) for site name + settings modal flag, fetched via ' +
      '`useSiteSummary` (lightweight cmsAdapter call) instead of ' +
      '`usePersistence`. This chunk MUST NOT pull `@site/store/store` ' +
      '— if it grows past ~12 KB, an admin-shell consumer almost ' +
      'certainly re-introduced the editor store dependency.',
  },

  // Heaviest lazy chunk — protected by the codemirror-lazy-only gate at the
  // import boundary, and by this size cap against silent CM6 dep upgrades.
  {
    prefix: 'CodeMirrorEditor-',
    maxBytes: 700_000,
    rationale:
      'lazy CodeMirror 6 chunk (current ~674 KB raw / ~230 KB gzipped). ' +
      'Only loaded when a user opens a text file in the code editor panel. ' +
      'Grew from ~606 KB when @codemirror/lang-html (bundling embedded CSS + ' +
      'JS grammar) was added for the HTML-import editor.',
  },

  // TypeScript's compiler and standard-library declarations are intentionally
  // isolated behind a browser Worker created only for authored .ts/.tsx files.
  // This cap makes a dependency upgrade explicit without charging the editor
  // or admin startup chunks for semantic language tooling.
  {
    prefix: 'typescriptWorker-',
    maxBytes: 7_600_000,
    rationale:
      'lazy TypeScript language-service worker (current ~7.37 MB raw). ' +
      'Contains the TypeScript compiler plus ES2020/DOM declaration text, ' +
      'and is loaded only when a user opens a TypeScript site script.',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findChunk(prefix: string): { path: string; size: number } | null {
  if (!existsSync(DIST_ASSETS)) return null
  const matches = readdirSync(DIST_ASSETS).filter(
    (f) => f.startsWith(prefix) && f.endsWith('.js'),
  )
  if (matches.length === 0) return null
  // A module reachable through BOTH a dynamic and a static import (e.g.
  // CodeMirrorEditor: lazy from CodeEditorPanel, static from its collab
  // sibling lazy module) makes rolldown emit a tiny re-export facade chunk
  // alongside the real one. Budget the SUM of all matches — that stays
  // facade-tolerant while still catching genuine duplication (two full
  // copies would blow the budget immediately).
  const size = matches.reduce(
    (total, match) => total + statSync(join(DIST_ASSETS, match)).size,
    0,
  )
  const path = join(DIST_ASSETS, matches[0]!)
  return { path, size }
}

function findChunks(prefix: string): string[] {
  if (!existsSync(DIST_ASSETS)) return []
  return readdirSync(DIST_ASSETS).filter(
    (f) => f.startsWith(prefix) && f.endsWith('.js'),
  )
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function vendoredIconNames(): string[] {
  return readdirSync(VENDORED_ICON_DIST)
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.slice(0, -'.js'.length))
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bundle size budgets', () => {
  if (!existsSync(DIST_ASSETS)) {
    it.skip('skipped: dist/assets/ not present — run `bun run build` first (or use `bun run test:bundle`)', () => {})
    // Surface the skip visibly so it's obvious in CI / local runs why this
    // gate didn't enforce anything. Matches the Phase G pre-registered gate
    // pattern (console.log when an architecture gate is dormant).
    console.warn(
      '[bundle-size-budgets] dist/assets/ missing — bundle gates skipped. ' +
      'Run `bun run build` first, or use `bun run test:bundle` to build+test.',
    )
    return
  }

  for (const budget of BUDGETS) {
    it(`${budget.prefix}*.js stays under ${formatKB(budget.maxBytes)}`, () => {
      const chunk = findChunk(budget.prefix)
      if (!chunk) {
        throw new Error(
          `[bundle-size-budgets] Expected chunk "${budget.prefix}*.js" not found ` +
          `in dist/assets/. If this chunk was intentionally removed or renamed, ` +
          `update src/__tests__/architecture/bundle-size-budgets.test.ts.`,
        )
      }
      if (chunk.size > budget.maxBytes) {
        throw new Error(
          `[bundle-size-budgets] ${budget.prefix}*.js exceeds budget.\n` +
          `  actual:    ${formatKB(chunk.size)} (${chunk.size} B)\n` +
          `  budget:    ${formatKB(budget.maxBytes)} (${budget.maxBytes} B)\n` +
          `  rationale: ${budget.rationale}\n\n` +
          `Either (a) split the new dependency behind a lazy boundary, or ` +
          `(b) raise the cap with a one-line note in this test file ` +
          `explaining why the growth is intentional.`,
        )
      }
      expect(chunk.size).toBeLessThanOrEqual(budget.maxBytes)
    })
  }

  it('react-vendor does not import the drag-and-drop vendor chunk', () => {
    const reactVendor = findChunk('react-vendor-')
    if (!reactVendor) {
      throw new Error(
        '[bundle-size-budgets] Expected react-vendor*.js in dist/assets/. ' +
        'Run `bun run build` first.',
      )
    }
    const source = readFileSync(reactVendor.path, 'utf8')
    expect(source).not.toContain('dnd-vendor-')
  })

  it('emits vendored pixel-art-icons as one chunk instead of per-icon chunks', () => {
    const iconVendorChunks = findChunks('pixel-art-icons-')
    expect(iconVendorChunks).toHaveLength(1)

    const iconChunkPatterns = vendoredIconNames().map(
      (iconName) => new RegExp(`^${regexEscape(iconName)}-[A-Za-z0-9_-]+\\.js$`),
    )
    const individualIconChunks = readdirSync(DIST_ASSETS).filter((asset) => {
      if (!iconChunkPatterns.some((pattern) => pattern.test(asset))) return false
      // Name-collision guard: rolldown names shared feature chunks after one
      // of their modules, and a feature module can legitimately share a name
      // with an icon (e.g. an "upload" helpers chunk vs the upload icon). A
      // chunk that IMPORTS the grouped icon chunk is a consumer, not an
      // escaped icon — only an actual icon module body (svg markup, no
      // grouped-chunk import) counts as a violation.
      const source = readFileSync(join(DIST_ASSETS, asset), 'utf8')
      const importsGroupedIcons = source.includes('./pixel-art-icons-')
      const looksLikeIconBody = source.includes('viewBox')
      return !importsGroupedIcons && looksLikeIconBody
    })

    expect(individualIconChunks).toEqual([])
  })
})
