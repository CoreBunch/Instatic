/**
 * Manage the Core Framework preset against an existing framework — the engine
 * behind the editor's "Manage framework" dialog.
 *
 *   • frameworkUtilityState — classify a framework as none / variables / full.
 *   • mergeCoreFrameworkSettings — re-import that ADDS ONLY what is missing
 *     (color tokens by slug, scale groups by namingConvention), preserving any
 *     existing / customized tokens. Empty input ⇒ a fresh full preset.
 *   • setFrameworkUtilities — flip utility-class generation on/off without
 *     touching the `:root` variables (the 'full' ⇄ 'variables' switch).
 *
 * All are pure: they compute a new `FrameworkSettings`; the store action assigns
 * it onto the draft and runs `reconcileFrameworkClasses`.
 */
import type {
  FrameworkSettings,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import {
  buildCoreFrameworkSettings,
  coreFrameworkColorUtilitiesForSlug,
  type CoreFrameworkImportOptions,
} from './coreFrameworkPreset'
import { generateFrameworkUtilityClasses } from './generate'

/**
 * The three declarative states a site's framework can be in, used by the
 * "Manage framework" dialog as a single target the user picks:
 *   • 'full'      — `:root` variables + generated utility classes
 *   • 'variables' — `:root` variables only, no generated utility classes
 *   • 'none'      — no framework at all
 */
export type FrameworkPreset = 'full' | 'variables' | 'none'

/**
 * Classify the framework's current state for the dialog's pre-selection and
 * button labelling. A framework that emits at least one utility class is
 * 'full'; one that emits only `:root` variables is 'variables'; absent is
 * 'none'.
 */
export function frameworkUtilityState(
  settings: FrameworkSettings | undefined,
): FrameworkPreset {
  if (!settings) return 'none'
  const hasClasses = Object.keys(generateFrameworkUtilityClasses(settings)).length > 0
  return hasClasses ? 'full' : 'variables'
}

/**
 * Flip utility-class generation on a framework without touching its `:root`
 * variables — the engine behind switching between the 'full' and 'variables'
 * states.
 *
 *   • `false` (→ variables): every color token's utilities go all-off and the
 *     typography / spacing class generators are dropped, so NO utility classes
 *     are emitted. Variables (base, shades, tints, transparent) are untouched.
 *   • `true`  (→ full): Core preset color tokens get their canonical utilities
 *     restored (by slug); user-authored tokens keep whatever they had. The
 *     typography / spacing class generators are re-seeded by the caller's merge
 *     step, so this only needs to handle colors + the tree-shake preference.
 *
 * Pure: returns a new `FrameworkSettings`; the store assigns it and reconciles.
 */
export function setFrameworkUtilities(
  settings: FrameworkSettings,
  includeUtilities: boolean,
): FrameworkSettings {
  const next: FrameworkSettings = structuredClone(settings)

  if (includeUtilities) {
    for (const token of next.colors.tokens) {
      const canonical = coreFrameworkColorUtilitiesForSlug(token.slug)
      if (canonical) token.generateUtilities = canonical
    }
  } else {
    for (const token of next.colors.tokens) {
      token.generateUtilities = { text: false, background: false, border: false, fill: false }
    }
    if (next.typography) next.typography.classes = []
    if (next.spacing) next.spacing.classes = []
  }

  if (next.preferences) {
    next.preferences.treeShakeGeneratedFrameworkUtilities = !includeUtilities
  }

  return next
}

/**
 * Compute the framework settings for a declarative target state — the single
 * source of truth shared by the store action, the onboarding importer, and the
 * dialog's change-preview. 'none' clears the framework; 'full' / 'variables'
 * merge the preset (add-missing) and flip utility generation to match.
 */
export function applyFrameworkPreset(
  existing: FrameworkSettings | undefined,
  target: FrameworkPreset,
): FrameworkSettings | undefined {
  if (target === 'none') return undefined
  const includeUtilities = target === 'full'
  return setFrameworkUtilities(
    mergeCoreFrameworkSettings(existing, { includeUtilities }),
    includeUtilities,
  )
}

/**
 * Merge the Core Framework preset into an existing framework, adding only what
 * is missing. Color tokens match by `slug`; typography / spacing groups by
 * `namingConvention`; preferences fill absent keys only. Existing (incl.
 * customized) tokens — and any user-authored class generators — are preserved.
 * Only an absent framework (`undefined`) seeds a fresh preset; a framework that
 * merely has no colors yet still merges (so a type/spacing-only setup keeps its
 * generated classes and just gains the missing color tokens).
 */
export function mergeCoreFrameworkSettings(
  existing: FrameworkSettings | undefined,
  options: CoreFrameworkImportOptions,
): FrameworkSettings {
  const preset = buildCoreFrameworkSettings(options)
  if (!existing) return preset

  const next: FrameworkSettings = structuredClone(existing)

  // Colors — append tokens whose slug is absent.
  const slugs = new Set(next.colors.tokens.map((t) => t.slug))
  for (const token of preset.colors.tokens) {
    if (slugs.has(token.slug)) continue
    next.colors.tokens.push({ ...token, order: next.colors.tokens.length })
  }

  next.typography = mergeScaleFamily(next.typography, preset.typography)
  next.spacing = mergeScaleFamily(next.spacing, preset.spacing)

  // Preferences — existing wins wholesale when present (it is fully populated
  // after schema parse); otherwise adopt the preset's.
  next.preferences = existing.preferences ?? preset.preferences

  return next
}

/** Add preset groups (by namingConvention) and class generators (by id) that are missing. */
function mergeScaleFamily<
  G extends FrameworkTypographyGroup | FrameworkSpacingGroup,
  S extends { groups: G[]; classes?: { id: string }[] },
>(existing: S | undefined, preset: S | undefined): S | undefined {
  if (!preset) return existing
  if (!existing) return preset
  const have = new Set(existing.groups.map((g) => g.namingConvention))
  for (const group of preset.groups) {
    if (!have.has(group.namingConvention)) existing.groups.push(group)
  }
  if (preset.classes) {
    const ids = new Set((existing.classes ?? []).map((c) => c.id))
    for (const cls of preset.classes) {
      if (!ids.has(cls.id)) (existing.classes ??= []).push(cls)
    }
  }
  return existing
}
