/**
 * Manage the Core Framework preset against an existing framework — the engine
 * behind the editor's "Manage framework" dialog.
 *
 *   • mergeCoreFrameworkSettings — re-import that ADDS ONLY what is missing
 *     (color tokens by slug, scale groups by namingConvention), preserving any
 *     existing / customized tokens. Empty input ⇒ a fresh full preset.
 *   • pruneUnusedFrameworkTokens — remove the color tokens / scale class
 *     generators whose generated utility classes are entirely unassigned.
 *     Variable-only tokens and scale GROUPS (they emit `:root` variables) stay.
 *
 * Both are pure: they compute a new `FrameworkSettings`; the store action
 * assigns it onto the draft and runs `reconcileFrameworkClasses`.
 */
import type {
  FrameworkSettings,
  FrameworkSpacingGroup,
  FrameworkTypographyGroup,
} from '@core/framework-schema'
import { buildCoreFrameworkSettings, type CoreFrameworkImportOptions } from './coreFrameworkPreset'
import { generateFrameworkUtilityClasses } from './generate'

/**
 * Merge the Core Framework preset into an existing framework, adding only what
 * is missing. Color tokens match by `slug`; typography / spacing groups by
 * `namingConvention`; preferences fill absent keys only. Existing (incl.
 * customized) tokens are preserved. Empty/undefined input ⇒
 * `buildCoreFrameworkSettings(options)`.
 */
export function mergeCoreFrameworkSettings(
  existing: FrameworkSettings | undefined,
  options: CoreFrameworkImportOptions,
): FrameworkSettings {
  const preset = buildCoreFrameworkSettings(options)
  if (!existing || existing.colors.tokens.length === 0) return preset

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

export interface PruneResult {
  next: FrameworkSettings
  /** Color-token slugs that were removed (for the UI summary). */
  removedSlugs: string[]
}

/**
 * Remove framework units whose generated utility classes are entirely unused:
 * color tokens that generate ≥1 class but none assigned, and typography /
 * spacing class generators with no used class. Variable-only color tokens
 * (0 classes) and the scale GROUPS are always kept.
 */
export function pruneUnusedFrameworkTokens(
  settings: FrameworkSettings,
  usedClassIds: Set<string>,
): PruneResult {
  const classes = generateFrameworkUtilityClasses(settings)

  const colorByTokenId = new Map<string, string[]>()
  const typoByGenId = new Map<string, string[]>()
  const spacingByGenId = new Map<string, string[]>()

  for (const [classId, rule] of Object.entries(classes)) {
    const g = rule.generated
    if (!g) continue
    if (g.family === 'color') push(colorByTokenId, g.sourceId, classId)
    else if (g.family === 'typography') push(typoByGenId, g.generatorId, classId)
    else if (g.family === 'spacing') push(spacingByGenId, g.generatorId, classId)
  }

  const noneUsed = (ids: string[] | undefined): boolean =>
    !!ids && ids.length > 0 && ids.every((id) => !usedClassIds.has(id))

  const next: FrameworkSettings = structuredClone(settings)
  const removedSlugs: string[] = []

  next.colors.tokens = next.colors.tokens.filter((token) => {
    if (noneUsed(colorByTokenId.get(token.id))) {
      removedSlugs.push(token.slug)
      return false
    }
    return true
  })

  if (next.typography?.classes) {
    next.typography.classes = next.typography.classes.filter(
      (cls) => !noneUsed(typoByGenId.get(cls.id)),
    )
  }
  if (next.spacing?.classes) {
    next.spacing.classes = next.spacing.classes.filter(
      (cls) => !noneUsed(spacingByGenId.get(cls.id)),
    )
  }

  return { next, removedSlugs }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
