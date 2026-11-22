import type { StyleRule } from '@core/page-tree'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import type { FrameworkColorVariableSets } from './colors'
import {
  formatFrameworkColorThemeCss,
  generateFrameworkColorPlan,
  generateFrameworkColorUtilityClasses,
  generateFrameworkColorVariableSets,
} from './colors'
import type { FrameworkScaleVariable } from './scaleModule'
import {
  generateFrameworkTypographyPlan,
  generateFrameworkTypographyUtilityClasses,
  generateFrameworkTypographyVariables,
} from './typography'
import {
  generateFrameworkSpacingPlan,
  generateFrameworkSpacingUtilityClasses,
  generateFrameworkSpacingVariables,
} from './spacing'
import { resolveFrameworkPreferences } from './preferences'
import type { FrameworkPreferences } from './scale'
import { formatCssVariableBlock } from './cssVariables'

export interface FrameworkGenerationSettings {
  colors?: FrameworkColorSettings | null
  typography?: FrameworkTypographySettings | null
  spacing?: FrameworkSpacingSettings | null
  preferences?: FrameworkPreferencesSettings | null
}

/**
 * The two framework CSS outputs the publisher needs, built together: the merged
 * `:root` variable block (+ color theme scopes) and the locked utility classes.
 */
interface FrameworkPlan {
  rootCss: string
  utilityClasses: Record<string, StyleRule>
}

/**
 * The `html { font-size }` rule that makes `1rem` equal `rootFontSize` px, the
 * size every rem token was converted against. Written as a percentage of the
 * browser default (10 → `62.5%`) rather than a px value so a visitor's own
 * browser font-size preference still scales the page.
 *
 * Empty unless the site opted in (`emitRootFontSize`), tokens are in rem, and
 * the root differs from the 16px browser default.
 */
function generateFrameworkRootFontSizeCss(preferences: FrameworkPreferences): string {
  if (!preferences.emitRootFontSize || !preferences.isRem) return ''
  if (preferences.rootFontSize === 16) return ''
  const percent = Number(((preferences.rootFontSize / 16) * 100).toFixed(4))
  return `html {\n  font-size: ${percent}%;\n}`
}

/**
 * Compose the framework root CSS: the root font-size rule, then the `:root`
 * block from the color variable sets and the scale variables, then the color
 * theme scopes. Shared by `generateFrameworkRootCss` (single output, the
 * canvas) and `buildFrameworkPlan` (both outputs, the publisher) so the editor
 * and the published page stay byte-identical.
 */
function composeFrameworkRootCss(
  preferences: FrameworkPreferences,
  colorVariables: FrameworkColorVariableSets,
  scaleVariables: FrameworkScaleVariable[],
): string {
  return [
    generateFrameworkRootFontSizeCss(preferences),
    formatCssVariableBlock(':root', [...colorVariables.light, ...scaleVariables]),
    formatFrameworkColorThemeCss(colorVariables),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function generateFrameworkRootCss(
  settings: FrameworkGenerationSettings | null | undefined,
): string {
  const preferences = resolveFrameworkPreferences(settings?.preferences)
  return composeFrameworkRootCss(preferences, generateFrameworkColorVariableSets(settings?.colors), [
    ...generateFrameworkTypographyVariables(settings?.typography, preferences),
    ...generateFrameworkSpacingVariables(settings?.spacing, preferences),
  ])
}

export function generateFrameworkUtilityClasses(
  settings: FrameworkGenerationSettings | null | undefined,
): Record<string, StyleRule> {
  return {
    ...generateFrameworkColorUtilityClasses(settings?.colors),
    ...generateFrameworkTypographyUtilityClasses(settings?.typography),
    ...generateFrameworkSpacingUtilityClasses(settings?.spacing),
  }
}

/**
 * Build the framework `:root` CSS and utility classes in one pass.
 *
 * Each family's variable + utility outputs are derived from a single shared,
 * ordered enumeration (`generateFramework*Plan`), so a publish walks each
 * family's tokens/groups once per pass instead of once per output. Equivalent
 * to `{ rootCss: generateFrameworkRootCss(s), utilityClasses: generateFrameworkUtilityClasses(s) }`
 * but without the duplicated traversals.
 */
export function buildFrameworkPlan(
  settings: FrameworkGenerationSettings | null | undefined,
): FrameworkPlan {
  const preferences = resolveFrameworkPreferences(settings?.preferences)
  const colors = generateFrameworkColorPlan(settings?.colors)
  const typography = generateFrameworkTypographyPlan(settings?.typography, preferences)
  const spacing = generateFrameworkSpacingPlan(settings?.spacing, preferences)

  return {
    rootCss: composeFrameworkRootCss(preferences, colors.variableSets, [
      ...typography.variables,
      ...spacing.variables,
    ]),
    utilityClasses: {
      ...colors.utilityClasses,
      ...typography.utilityClasses,
      ...spacing.utilityClasses,
    },
  }
}
