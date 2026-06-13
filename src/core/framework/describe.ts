/**
 * Single source of truth for "what design tokens does this site expose, and
 * how do you reference each one".
 *
 * The framework engine already derives two parallel outputs from
 * `settings.framework`: CSS custom properties (`generateFramework*Variables`)
 * and locked utility classes (`generateFramework*UtilityClasses`). The agent
 * needs both, paired up: for every token it must know the `--var` to drop into
 * a `<style>` block AND the utility class(es) bound to it.
 *
 * Re-deriving variable names in the agent layer would drift from what is
 * actually generated into `:root`. Instead `describeFrameworkTokens` reuses the
 * same generators and joins their outputs by the shared token/group identity,
 * so the agent can never be told about a variable the stylesheet doesn't emit.
 */

import { generateFrameworkColorPlan } from './colors'
import type { FrameworkGenerationSettings } from './generate'
import { resolveFrameworkPreferences } from './preferences'
import type { FrameworkScaleVariable } from './scaleModule'
import type {
  FrameworkColorSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import { generateFrameworkSpacingPlan } from './spacing'
import { generateFrameworkTypographyPlan } from './typography'

interface TokenDescriptor {
  /** CSS custom property incl. leading dashes, e.g. "--primary". */
  cssVar: string
  /** `var(--…)` expression ready to drop into a style value. */
  ref: string
  /** Utility class names bound to this token, e.g. ["text-primary","bg-primary"]. */
  utilityClasses: string[]
  /** Resolved value (light theme / min breakpoint), for the digest. */
  value: string
}

interface ColorVariantDescriptor extends TokenDescriptor {
  /** Variant label, e.g. "d-1" (shade), "l-2" (tint), "30" (transparent). */
  variant: string
}

interface ColorTokenDescriptor extends TokenDescriptor {
  slug: string
  category: string
  /** Resolved dark-theme value, present only when the token enables dark mode. */
  darkValue?: string
  /** Generated shades / tints / transparencies. */
  variants: ColorVariantDescriptor[]
}

interface ScaleStepDescriptor extends TokenDescriptor {
  /** Step label as authored in the group's `steps` string, e.g. "xs","m","2xl". */
  step: string
}

interface ScaleGroupDescriptor {
  id: string
  family: 'typography' | 'spacing'
  name: string
  /** Variable/class naming convention, e.g. "text" or "space". */
  namingConvention: string
  steps: ScaleStepDescriptor[]
}

interface FrameworkTokenDigest {
  colors: ColorTokenDescriptor[]
  typography: ScaleGroupDescriptor[]
  spacing: ScaleGroupDescriptor[]
}

const EMPTY_DIGEST: FrameworkTokenDigest = { colors: [], typography: [], spacing: [] }

export function describeFrameworkTokens(
  settings: FrameworkGenerationSettings | null | undefined,
): FrameworkTokenDigest {
  if (!settings) return EMPTY_DIGEST
  const preferences = resolveFrameworkPreferences(settings.preferences)
  const typography = generateFrameworkTypographyPlan(settings.typography, preferences)
  const spacing = generateFrameworkSpacingPlan(settings.spacing, preferences)
  return {
    colors: describeColors(settings.colors),
    typography: describeScale('typography', typography.variables, typography.utilityClasses, settings.typography),
    spacing: describeScale('spacing', spacing.variables, spacing.utilityClasses, settings.spacing),
  }
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Variant identity shared by a color variable and its utility class. */
function colorVariantKey(tokenId: string, variantName: string | undefined): string {
  return `${tokenId}:${variantName ?? 'base'}`
}

function describeColors(
  settings: FrameworkColorSettings | null | undefined,
): ColorTokenDescriptor[] {
  if (!settings || settings.tokens.length === 0) return []

  const { variableSets: sets, utilityClasses } = generateFrameworkColorPlan(settings)

  // Pair each (token, variant) with the utility class names targeting it.
  const classNames = new Map<string, string[]>()
  for (const rule of Object.values(utilityClasses)) {
    const meta = rule.generated
    if (!meta || meta.origin !== 'framework' || meta.family !== 'color') continue
    const key = colorVariantKey(meta.sourceId, meta.variantName)
    const list = classNames.get(key)
    if (list) list.push(rule.name)
    else classNames.set(key, [rule.name])
  }

  // Dark base values keyed by token.
  const darkBaseByToken = new Map<string, string>()
  for (const variable of sets.dark) {
    if (variable.variantName === undefined) darkBaseByToken.set(variable.tokenId, variable.value)
  }

  const categoryByToken = new Map(settings.tokens.map((t) => [t.id, t.category]))

  // Group light variables by token, preserving generation order.
  const order: string[] = []
  const byToken = new Map<string, ColorTokenDescriptor>()

  for (const variable of sets.light) {
    const classesForVariant = classNames.get(colorVariantKey(variable.tokenId, variable.variantName)) ?? []
    if (variable.variantName === undefined) {
      order.push(variable.tokenId)
      const darkValue = darkBaseByToken.get(variable.tokenId)
      byToken.set(variable.tokenId, {
        slug: variable.slug,
        category: categoryByToken.get(variable.tokenId) ?? '',
        cssVar: variable.name,
        ref: `var(${variable.name})`,
        value: variable.value,
        utilityClasses: classesForVariant,
        ...(darkValue !== undefined ? { darkValue } : {}),
        variants: [],
      })
    } else {
      byToken.get(variable.tokenId)?.variants.push({
        variant: variable.variantName,
        cssVar: variable.name,
        ref: `var(${variable.name})`,
        value: variable.value,
        utilityClasses: classesForVariant,
      })
    }
  }

  return order.map((id) => byToken.get(id)!).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Scales (typography + spacing)
// ---------------------------------------------------------------------------

interface ScaleSettingsLike {
  groups: { id: string; namingConvention: string }[]
}

function describeScale(
  family: 'typography' | 'spacing',
  variables: FrameworkScaleVariable[],
  utilityClasses: Record<string, { name: string; generated?: unknown }>,
  settings: (FrameworkTypographySettings | FrameworkSpacingSettings) | null | undefined,
): ScaleGroupDescriptor[] {
  if (variables.length === 0) return []

  // Pair each (group, step) with the utility class names targeting it.
  const classNames = new Map<string, string[]>()
  for (const rule of Object.values(utilityClasses)) {
    const meta = rule.generated as
      | { origin?: string; family?: string; sourceId?: string; step?: string }
      | undefined
    if (!meta || meta.origin !== 'framework' || meta.family !== family) continue
    if (!meta.sourceId || meta.step === undefined) continue
    const key = `${meta.sourceId}:${meta.step}`
    const list = classNames.get(key)
    if (list) list.push(rule.name)
    else classNames.set(key, [rule.name])
  }

  const namingByGroup = new Map(
    ((settings as ScaleSettingsLike | null | undefined)?.groups ?? []).map((g) => [
      g.id,
      g.namingConvention,
    ]),
  )

  const order: string[] = []
  const byGroup = new Map<string, ScaleGroupDescriptor>()

  for (const variable of variables) {
    let group = byGroup.get(variable.groupId)
    if (!group) {
      order.push(variable.groupId)
      group = {
        id: variable.groupId,
        family,
        name: variable.groupName,
        namingConvention: namingByGroup.get(variable.groupId) ?? '',
        steps: [],
      }
      byGroup.set(variable.groupId, group)
    }
    group.steps.push({
      step: variable.step,
      cssVar: variable.name,
      ref: `var(${variable.name})`,
      value: variable.value,
      utilityClasses: classNames.get(`${variable.groupId}:${variable.step}`) ?? [],
    })
  }

  return order.map((id) => byGroup.get(id)!)
}
