/**
 * Framework typography — fluid type scales.
 *
 * Mirrors the Core Framework `typography` module (multi-group tabs,
 * Automatic + Manual modes, configurable Class Generator). The output
 * shape is identical to Core Framework's:
 *
 *   :root { --text-xs: clamp(...); ... }
 *   .text-xs { font-size: var(--text-xs); }
 *
 * so a published page from this builder is byte-compatible with a Core
 * Framework stylesheet of the same configuration.
 *
 * Sister of `framework/spacing.ts`. The math, mode handling, naming, and
 * class-pattern expansion live in `scaleModule.ts` — both files are thin
 * adapters over the shared engine.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type {
  FrameworkTypographyClassGenerator,
  FrameworkTypographyGroup,
  FrameworkTypographySettings,
} from '@core/framework-schema'
import { createFrameworkScaleModule, type FrameworkScaleModule } from './scaleModule'

const PROPERTY_KEYMAP: Record<string, keyof CSSPropertyBag> = {
  'font-size': 'fontSize',
  'line-height': 'lineHeight',
  'letter-spacing': 'letterSpacing',
  'font-weight': 'fontWeight',
}

// Annotated for the same reason as `spacingModule` in `spacing.ts`.
const typographyModule: FrameworkScaleModule<
  FrameworkTypographyGroup,
  FrameworkTypographyClassGenerator
> = createFrameworkScaleModule({
  family: 'typography',
  getMinBaseSize: (group) => group.min.fontSize,
  getMaxBaseSize: (group) => group.max.fontSize,
  getMinScaleConfig: (group) => group.min,
  getMaxScaleConfig: (group) => group.max,
  propertyKeymap: PROPERTY_KEYMAP,
  classTags: ['framework', 'utility', 'typography'],
})

export function generateFrameworkTypographyVariables(
  settings: FrameworkTypographySettings | null | undefined,
  preferences: Parameters<typeof typographyModule.generateVariables>[1],
) {
  return typographyModule.generateVariables(settings, preferences)
}

export function generateFrameworkTypographyUtilityClasses(
  settings: FrameworkTypographySettings | null | undefined,
) {
  return typographyModule.generateUtilityClasses(settings)
}

/** Typography variables + utility classes from a single shared group enumeration. */
export function generateFrameworkTypographyPlan(
  settings: FrameworkTypographySettings | null | undefined,
  preferences: Parameters<typeof typographyModule.generatePlan>[1],
) {
  return typographyModule.generatePlan(settings, preferences)
}
