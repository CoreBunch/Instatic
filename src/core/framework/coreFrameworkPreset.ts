/**
 * Core Framework default preset — the importable "starter" framework.
 *
 * Maps the Core Framework default project (the colors, typography scale,
 * spacing scale and utility-class generators a fresh Core Framework project
 * ships with) into Instatic's structured `FrameworkSettings` shape.
 *
 * Sources mirrored verbatim from the Core Framework repo
 * (`packages/core/src/...`):
 *   • Colors      — `components/modules/colorSystem/data/defaults.ts`
 *                   (COLOR_SYSTEM_INITIAL_STATE): 6 groups / 13 tokens.
 *   • Typography  — `data/defaults.ts` (TYPOGRAPHY_INITIAL_STATE) — already
 *                   mirrored by `buildDefaultTypographySettings`.
 *   • Spacing     — `data/defaults.ts` (SPACING_CALCULATOR_INITIAL_STATE) —
 *                   already mirrored by `buildDefaultSpacingSettings`.
 *   • Preferences — `data/defaults.ts` (DEFAULT_PREFERENCES): rootFontSize 10,
 *                   screen 320–1400, rem.
 *
 * Two import modes (`includeUtilities`):
 *   • `true`  — the FULL framework: every token's utility classes
 *               (`.bg-primary`, `.text-primary-l-2`, …) plus the typography /
 *               spacing class generators (`.text-*`, `.padding-*`, …) AND the
 *               `:root` variables. Tree-shaking is turned OFF so the complete
 *               generated utility set lands in `framework.css`.
 *   • `false` — VARIABLES ONLY: the same `:root` custom properties (base
 *               colors, shades, tints, transparent steps, scale clamps) with
 *               NO utility classes. Color `generateUtilities` is all-off and
 *               the typography / spacing class generators are dropped.
 *
 * Shade / tint values are generated from a count by Instatic's own algorithm
 * (the schema stores a count, not hand-authored values), so they are close to
 * — but not byte-identical with — Core Framework's hand-tuned shade swatches.
 */

import { nanoid } from 'nanoid'
import type {
  FrameworkColorSettings,
  FrameworkColorToken,
  FrameworkColorUtilityType,
  FrameworkPreferencesSettings,
  FrameworkSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import {
  buildDefaultSpacingGroup,
  buildDefaultSpacingSettings,
  buildDefaultTypographyGroup,
  buildDefaultTypographySettings,
} from './defaults'

export interface CoreFrameworkImportOptions {
  /**
   * `true` imports the full framework (utility classes + variables);
   * `false` imports variables only (no generated utility classes).
   */
  includeUtilities: boolean
}

// ---------------------------------------------------------------------------
// Color seed — Core Framework COLOR_SYSTEM_INITIAL_STATE, flattened.
// ---------------------------------------------------------------------------

/** Core Framework's `gen` tokens map onto Instatic utility kinds. */
type CoreGenToken = 'text' | 'bg' | 'border' | 'fill'

interface CoreColorSeed {
  category: string
  slug: string
  lightValue: string
  /** Empty string when the Core Framework token has no dark-mode value. */
  darkValue: string
  /** Which utility kinds Core Framework generates for this token. */
  gen: CoreGenToken[]
  transparent: boolean
  shades: number
  tints: number
}

/**
 * The 13 default tokens across Core Framework's 6 default groups. `shades` /
 * `tints` are the Core Framework counts; a count of 0 means that variant family
 * is disabled for the token (Core Framework `isShades` / `isTints` === false).
 */
const CORE_COLOR_SEED: CoreColorSeed[] = [
  // ── Brand ──────────────────────────────────────────────────────────────
  { category: 'Brand', slug: 'primary',   lightValue: 'hsla(238, 100%, 62%, 1)', darkValue: '', gen: ['text', 'bg', 'border'], transparent: true, shades: 4, tints: 4 },
  { category: 'Brand', slug: 'secondary', lightValue: 'hsla(0, 94%, 68%, 1)',    darkValue: '', gen: ['border', 'bg', 'text'], transparent: true, shades: 4, tints: 4 },
  { category: 'Brand', slug: 'tertiary',  lightValue: 'hsla(198, 74%, 51%, 1)',  darkValue: '', gen: ['text', 'bg', 'border'], transparent: true, shades: 4, tints: 4 },
  // ── Background ─────────────────────────────────────────────────────────
  { category: 'Background', slug: 'bg-body',    lightValue: 'hsla(0, 0%, 90%, 1)',  darkValue: 'hsla(0, 0%, 5%, 1)',  gen: ['bg'], transparent: false, shades: 0, tints: 0 },
  { category: 'Background', slug: 'bg-surface', lightValue: 'hsla(0, 0%, 100%, 1)', darkValue: 'hsla(0, 0%, 15%, 1)', gen: ['bg'], transparent: false, shades: 0, tints: 0 },
  // ── Text ───────────────────────────────────────────────────────────────
  { category: 'Text', slug: 'text-body',  lightValue: 'hsla(0, 0%, 25%, 1)', darkValue: 'hsla(0, 0%, 75%, 1)',  gen: ['text'], transparent: false, shades: 0, tints: 0 },
  { category: 'Text', slug: 'text-title', lightValue: 'hsla(0, 0%, 0%, 1)',  darkValue: 'hsla(0, 0%, 100%, 1)', gen: ['text'], transparent: false, shades: 0, tints: 0 },
  // ── Base ───────────────────────────────────────────────────────────────
  { category: 'Base', slug: 'border-primary', lightValue: 'hsla(0, 0%, 50%, 0.25)', darkValue: 'hsla(0, 0%, 75%, 0.1)', gen: ['border'], transparent: false, shades: 0, tints: 0 },
  // `shadow-primary` has no `gen` in Core Framework — it is a variable only,
  // never a utility class, in either import mode.
  { category: 'Base', slug: 'shadow-primary', lightValue: 'hsla(0, 0%, 0%, 0.15)',  darkValue: 'hsla(0, 0%, 0%, 0.4)',  gen: [],         transparent: false, shades: 0, tints: 0 },
  // ── Neutral ────────────────────────────────────────────────────────────
  { category: 'Neutral', slug: 'light', lightValue: 'hsla(85, 0%, 100%, 1)', darkValue: 'hsla(0, 0%, 0%, 1)',   gen: ['bg', 'text', 'border'], transparent: true, shades: 0, tints: 0 },
  { category: 'Neutral', slug: 'dark',  lightValue: 'hsla(0, 0%, 0%, 1)',    darkValue: 'hsla(0, 0%, 100%, 1)', gen: ['bg', 'text', 'border'], transparent: true, shades: 0, tints: 0 },
  // ── Status ─────────────────────────────────────────────────────────────
  { category: 'Status', slug: 'success', lightValue: 'hsla(136, 95%, 56%, 1)', darkValue: '', gen: ['text', 'bg', 'border'], transparent: true, shades: 0, tints: 0 },
  { category: 'Status', slug: 'error',   lightValue: 'hsla(351, 95%, 56%, 1)', darkValue: '', gen: ['text', 'bg', 'border'], transparent: true, shades: 0, tints: 0 },
]

function genToUtilities(
  gen: CoreGenToken[],
  includeUtilities: boolean,
): Record<FrameworkColorUtilityType, boolean> {
  // Variables-only mode: every utility kind off — the token still emits its
  // `:root` variables (base + variants), just no `.text-*` / `.bg-*` classes.
  if (!includeUtilities) {
    return { text: false, background: false, border: false, fill: false }
  }
  return {
    text: gen.includes('text'),
    background: gen.includes('bg'),
    border: gen.includes('border'),
    fill: gen.includes('fill'),
  }
}

export function buildCoreFrameworkColorSettings(
  options: CoreFrameworkImportOptions,
): FrameworkColorSettings {
  const now = Date.now()
  const tokens: FrameworkColorToken[] = CORE_COLOR_SEED.map((seed, index) => ({
    id: nanoid(),
    category: seed.category,
    slug: seed.slug,
    lightValue: seed.lightValue,
    darkValue: seed.darkValue,
    darkModeEnabled: seed.darkValue !== '',
    generateUtilities: genToUtilities(seed.gen, options.includeUtilities),
    // Transparent / shade / tint VARIABLES are emitted in both modes; whether
    // they also produce utility CLASSES is gated by `generateUtilities` above.
    generateTransparent: seed.transparent,
    generateShades: { enabled: seed.shades > 0, count: seed.shades || 4 },
    generateTints: { enabled: seed.tints > 0, count: seed.tints || 4 },
    order: index,
    createdAt: now,
    updatedAt: now,
  }))
  return { tokens }
}

// ---------------------------------------------------------------------------
// Typography / spacing — reuse the existing Core-Framework-mirroring defaults.
// In variables-only mode the class generators are dropped (no `.text-*` /
// `.padding-*` utilities) while the scale `:root` variables still emit.
// ---------------------------------------------------------------------------

function buildCoreTypographySettings(
  options: CoreFrameworkImportOptions,
): FrameworkTypographySettings {
  if (options.includeUtilities) return buildDefaultTypographySettings()
  return { groups: [buildDefaultTypographyGroup()], classes: [] }
}

function buildCoreSpacingSettings(
  options: CoreFrameworkImportOptions,
): FrameworkSpacingSettings {
  if (options.includeUtilities) return buildDefaultSpacingSettings()
  return { groups: [buildDefaultSpacingGroup()], classes: [] }
}

// ---------------------------------------------------------------------------
// Preferences — Core Framework DEFAULT_PREFERENCES.
// ---------------------------------------------------------------------------

function buildCoreFrameworkPreferences(
  options: CoreFrameworkImportOptions,
): FrameworkPreferencesSettings {
  return {
    rootFontSize: 10,
    minScreenWidth: 320,
    maxScreenWidth: 1400,
    isRem: true,
    // Full import means "ship the whole framework": emit every generated
    // utility class, not just the ones already assigned in the tree. Variables-
    // only has no utility classes, so the flag is moot — keep it on (default).
    treeShakeGeneratedFrameworkUtilities: !options.includeUtilities,
  }
}

// ---------------------------------------------------------------------------
// Top-level builder.
// ---------------------------------------------------------------------------

/**
 * Build a complete `FrameworkSettings` from the Core Framework default preset.
 * Drop this onto `site.settings.framework` to import the framework.
 */
export function buildCoreFrameworkSettings(
  options: CoreFrameworkImportOptions,
): FrameworkSettings {
  return {
    colors: buildCoreFrameworkColorSettings(options),
    typography: buildCoreTypographySettings(options),
    spacing: buildCoreSpacingSettings(options),
    preferences: buildCoreFrameworkPreferences(options),
  }
}
