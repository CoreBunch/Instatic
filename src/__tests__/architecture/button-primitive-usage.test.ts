/**
 * BTN-3 — Button Primitive Usage Gate (Task #462)
 *
 * Every interactive button in src/admin/ and src/admin/pages/site/ MUST use the shared Button primitive
 * (src/ui/components/Button/Button.tsx).  Raw <button JSX elements are
 * banned except in the §8 allowlist below.
 *
 * ALLOWLIST contains the ONLY files permitted to contain bare <button — either
 * because they ARE the Button primitive or because they carry a legitimate §8
 * design-system exception documented in Contribution #667.
 *
 * §8 exceptions:
 *   §8.1 Settings nav buttons — full-width left-sidebar navigation (SettingsModal)
 *   §8.2 Full-width disclosure toggles — Section, DepsSection,
 *         PropertyControlRenderer
 *   §8.3 Pill micro-remove buttons — ClassPicker (< 20×20px fixed,
 *         Button's 26px min-height would distort pill layout)
 *   §8.4 Toggle switch hit areas — ToggleControl, PreferencesSection
 *         (role="switch", custom 44×44 WCAG 2.5.5 hit area not achievable via
 *         Button's fixed size tokens)
 *
 * @see Contribution #667 — Button Design System Phase 2 spec (parent: this task)
 * @see Task #462 — Button Design System Phase 2 (37-file migration)
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')
const ADMIN_ROOT = join(SRC_ROOT, 'admin')
const EDITOR_ROOT = join(SRC_ROOT, 'editor')
const SCAN_ROOTS = [
  { label: 'admin', root: ADMIN_ROOT },
  { label: 'editor', root: EDITOR_ROOT },
]

// ---------------------------------------------------------------------------
// TSX file walker
// ---------------------------------------------------------------------------

function collectTSXFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTSXFiles(full))
    } else if (extname(entry) === '.tsx') {
      results.push(full)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// §8 allowlist — files permitted to contain bare <button elements
// Paths are relative to src/ for readability.
// ---------------------------------------------------------------------------

/**
 * Each entry is a path relative to src/ that is permitted to contain
 * one or more bare <button elements.  ALL entries must have a §8 justification
 * comment here; new entries without justification will fail code review.
 */
const ALLOWLIST = new Set([
  // ── §8.1 Settings nav buttons ────────────────────────────────────────────
  // Full-width left-sidebar navigation links styled as nav items.
  // Using Button would break the nav-item layout (full-width, icon+text, active state).
  'admin/modals/Settings/SettingsModal.tsx',

  // ── §8.2 Full-width disclosure toggles ──────────────────────────────────
  // These are collapsible section headers that span the full panel width.
  // Button's inline-flex sizing and padding do not fit a full-width disclosure pattern.
  'admin/pages/site/panels/PropertiesPanel/Section.tsx',
  'admin/pages/site/panels/DependenciesPanel/DepsSection.tsx',
  'admin/pages/site/property-controls/PropertyControlRenderer.tsx',

  // ── §8.4 Toggle switch hit areas ────────────────────────────────────────
  // role="switch" toggle controls need a 44×44 WCAG 2.5.5 transparent hit area
  // wrapped around the visual pill.  This is a custom <button layout that does
  // not fit Button's token-driven size system.
  'admin/pages/site/property-controls/ToggleControl.tsx',
  'admin/modals/Settings/sections/PreferencesSection.tsx',

  // ── §8.5 Content workspace structured rows and editor canvas controls ───
  // Content explorer rows reuse full-surface row patterns that Button's
  // inline-flex sizing would distort.
  'admin/pages/content/components/ContentExplorerPanel/ContentExplorerPanel.tsx',

  // ── §8.6 ARIA tablist tabs ──────────────────────────────────────────────
  // role="tab" buttons inside role="tablist" need a custom tab layout
  // (icon + label, aria-selected, no border, mode-specific active state).
  // Button's token-driven sizing would distort the segmented-toggle look.
  // The same pill also hosts the Run-scripts toggle + Refresh and the inline
  // breakpoint switcher, which share the 22px icon-tab geometry.
  'admin/pages/site/canvas/CanvasModeToggle.tsx',
  // Content workspace's Write / Live mode switch — mirrors the canvas
  // mode toggle's segmented pill pattern and shares the same constraints.
  'admin/pages/content/components/ContentModeToggle/ContentModeToggle.tsx',

  // ── §8.8 SEO target index rows ──────────────────────────────────────────
  // role="option" rows inside the SEO workspace's role="listbox" target
  // index: full-width two-line rows (title + route, score pill right) and
  // the pinned Site defaults card. Button's fixed per-size heights and
  // white-space: nowrap crush the two-line layout — same rationale as the
  // §8.1 nav rows and §8.7 listbox options.
  'admin/pages/seo/components/SeoTargetIndex.tsx',

  // ── §8.11 SEO advice rows (recommendations + improvements) ──────────────
  // The Meta editor's improvements list and the Robots tab's recommendation
  // list render full-width rows (status dot + wrapping two-line advice text)
  // that apply a fix / focus a field on click. Button's fixed heights and
  // white-space: nowrap cannot host wrapping multi-line row content — same
  // pattern class as the §8.8 index rows.
  'admin/pages/seo/components/SeoPreviewEditor.tsx',
  'admin/pages/seo/tabs/RobotsTab.tsx',

  // ── §8.7 Full-width row disclosure / listbox option custom layouts ──────
  // ColorTokenCard row toggle is a full-width structured row (title + meta,
  // expand caret pattern) — same pattern as §8.2 disclosures but on a
  // multi-cell row layout that Button's inline-flex sizing cannot represent.
  // CategoryComboBox renders role="option" items inside a role="listbox"
  // dropdown — Button's inline-flex layout cannot represent the option grid.
  // TokenizedColorField renders role="option" items inside a role="listbox"
  // with a swatch + token name + variant meta — Button's inline-flex layout
  // cannot represent the option grid.
  // AddGoogleFontDialog renders role="option" tiles inside a 2-column grid
  // with stacked content (large family-rendered preview on top, category
  // label below) — Button's fixed-height inline-flex row layout cannot
  // represent the card-style grid the font picker needs.
  'admin/pages/site/panels/ColorsPanel/ColorTokenCard.tsx',
  'admin/pages/site/panels/ColorsPanel/CategoryComboBox.tsx',
  'admin/pages/site/property-controls/TokenizedColorField.tsx',
  'admin/pages/site/panels/TypographyPanel/FontsSection/AddGoogleFontDialog.tsx',

  // ── §8.10 DateTimePicker calendar day-grid cells ────────────────────────
  // The calendar grid is `role="grid"` and each day is a structured
  // `role="gridcell"` button — arrow-key navigation, aria-selected, custom
  // selection states (today / selected / outside / disabled). Button's
  // inline-flex sizing + token-driven size system can't express the
  // square 28x28 grid cell layout, and `role="gridcell"` requires a
  // bare <button> element so screen readers expose the right semantics.
  // Same pattern class as §8.6 (custom ARIA role + bespoke structural
  // layout).
  'ui/components/DateTimePicker/DateTimePicker.tsx',

  // ── §8.9 Dashboard block library drag-preview tiles ─────────────────────
  // BlockLibrary's preview tile is a structured drag-source canvas sized to
  // the widget's natural `defaultSize × default rows` footprint (set inline
  // by the parent tile). The whole surface is the widget renderer; dnd-kit
  // drag listeners attach to this element so the user can drag the preview
  // up to the dashboard grid. Button's inline-flex size tokens (sm = 26px,
  // lg = 44px) cannot represent this custom-sized canvas — same pattern
  // class as §8.5 (full-surface media tiles) but with dnd-kit listeners
  // attached.
  'admin/pages/dashboard/components/BlockLibrary.tsx',

  // ── §8.8 DataGrid custom CSS-Grid cells ─────────────────────────────────
  // The Data table is a CSS-Grid (display: grid + display: contents on rows)
  // with sticky column / group headers. Two grid-cell types cannot be
  // expressed with Button's inline-flex layout:
  //
  // • DataGridHeaderCell renders role="columnheader" inside a 36px grid
  //   row with a structured layout (field icon + label + required indicator
  //   + sort caret). Button does not allow role overrides, and a sticky
  //   columnheader's grid-cell sizing differs from Button's size tokens.
  //   This is the same pattern class as §8.6 (custom ARIA role + custom
  //   structural layout).
  //
  // • DataGridGroupHeader is a grid-column-spanning (1 / -1) sticky
  //   disclosure toggle (status dot + label + count, collapsible).
  //   This is the exact §8.2 full-width-disclosure pattern, but inside a
  //   CSS-Grid row rather than a panel section.
  'admin/pages/data/components/DataGrid/DataGridHeaderCell.tsx',
  'admin/pages/data/components/DataGrid/DataGridGroupHeader.tsx',

  // ── §8.11 BorderControl side / corner picker hit areas ──────────────────
  // The visual border editor's side picker renders four absolutely-positioned
  // thin edge bars (6px wide/tall) inside a 72×72 box, and the radius corner
  // picker renders four 14×14 corner dots. Each is a clickable hit area whose
  // geometry IS the affordance (which edge / corner you're editing). Button's
  // token-driven size system (micro = 18px, sm = 26px) cannot represent a 6px
  // edge bar or a corner-anchored dot — same pattern class as §8.10's
  // grid-cell day buttons (bespoke positioned hit area, custom selected
  // state). These are the only bare <button>s in the file.
  'admin/pages/site/panels/PropertiesPanel/BorderControl/BorderControl.tsx',

  // ── §8.12 Super Import "Review" category navigator ──────────────────────
  // AnalyzeStep is the Review step's category navigator (Direction B). Its
  // bare <button>s are all custom structured layouts Button's inline-flex
  // size tokens cannot represent:
  // • nav items — full-width 4-cell rows (tint dot + label + count + green
  //   include-state dot), the §8.7 full-width-row pattern;
  // • the "Add more files" affordance — a dashed 2-column drop target (30px
  //   icon tile + stacked title/sub), a bespoke drag/drop surface;
  // • the per-stylesheet disclosure chevron — the §8.2 caret pattern;
  // • the "All" / "None" bulk text links — 11.5px inline text actions, not
  //   the token-driven Button sizes.
  'admin/modals/SiteImport/steps/AnalyzeStep.tsx',
  // CMS transfer bundles reuse the same Super Import review navigator geometry
  // as AnalyzeStep: full-width category rows, dashed choose-file affordance,
  // and inline All / None text actions. Button's inline-flex size tokens
  // cannot represent those structured row surfaces.
  'admin/modals/SiteImport/steps/CmsBundleAnalyzeStep.tsx',

  // ── §8.13 Export site dialog category navigator ─────────────────────────
  // ExportDialog is the sibling of §8.12 — the same category-navigator
  // pattern, on the export side. Its bare <button>s are:
  // • nav items — full-width 4-cell rows (tint dot + label + count + green
  //   include-state dot), identical to §8.12's nav-item / §8.7 pattern;
  // • the "Select all" / "Select none" bulk text links — 11.5px inline text
  //   actions, not the token-driven Button sizes (same as §8.12).
  'admin/pages/data/components/ExportDialog/ExportDialog.tsx',
])

// ---------------------------------------------------------------------------
// BTN-3 gate
// ---------------------------------------------------------------------------

describe('BTN-3 — Button primitive usage gate', () => {
  it('all <button elements in src/admin and src/admin/pages/site are either the Button primitive or an §8 exception', () => {
    const files = SCAN_ROOTS.flatMap(({ root }) => collectTSXFiles(root))
    const violations: string[] = []

    for (const file of files) {
      const rel = relative(SRC_ROOT, file)

      // Skip allowlisted files
      if (ALLOWLIST.has(rel)) continue

      const source = readFileSync(file, 'utf-8')

      // Match bare <button followed by a space or > (i.e. not <Button which is the primitive).
      // The capital-B <Button is the primitive; lowercase <button is forbidden outside the allowlist.
      if (/<button[\s>/]/.test(source)) {
        violations.push(rel)
      }
    }

    if (violations.length > 0) {
      const list = violations.map((v) => `  - ${v}`).join('\n')
      console.error(`BTN-3 FAIL: bare <button found outside allowlist:\n${list}`)
    }

    expect(violations).toEqual([])
  })

  it('Button primitive owns the shared 44px touch-target size', () => {
    const source = readFileSync(join(SRC_ROOT, 'ui/components/Button/Button.tsx'), 'utf-8')
    const css = readFileSync(join(SRC_ROOT, 'ui/components/Button/Button.module.css'), 'utf-8')

    expect(source).toMatch(/["']lg["']/)
    expect(css).toMatch(/\.size-lg\s*\{[\s\S]*height:\s*44px/)
    expect(css).toMatch(/\.size-lg\.iconOnly\s*\{[\s\S]*width:\s*44px/)
  })
})
