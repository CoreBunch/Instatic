/**
 * Framework spacing — fluid spacing scales.
 *
 * Sister of `framework/typography.ts`. The math, mode handling, naming, and
 * class-pattern expansion are identical between the two — both files are
 * thin adapters over `createFrameworkScaleModule` in `scaleModule.ts`.
 *
 * Spacing-specific bits:
 *   - the per-group base size lives at `group.min.size` / `group.max.size`,
 *   - the supported CSS properties are padding/margin/gap (not font-size),
 *   - the supported scale ratios extend up to Perfect Octave (2)
 *     (declared in `scale.ts::SPACING_RATIO_OPTIONS`).
 */

import type { CSSPropertyBag } from '@core/page-tree'
import type {
  FrameworkSpacingClassGenerator,
  FrameworkSpacingGroup,
  FrameworkSpacingSettings,
} from '@core/framework-schema'
import { createFrameworkScaleModule, type FrameworkScaleModule } from './scaleModule'

// Property keymap — translates a class generator's CSS-style property name
// (kebab-case, as it appears in `FrameworkSpacingClassGenerator.property`)
// to the corresponding `CSSPropertyBag` key (camelCase). The `padding` and
// `margin` shorthand names are intentionally absent: per CSSPropertyBagSchema,
// only the per-side keys exist in storage. The `padding-*` / `margin-*` class
// generators expand to all four sides via this keymap; the publisher then
// collapses them back into a CSS shorthand at emission time.
const PROPERTY_KEYMAP = {
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  'padding-top': 'paddingTop',
  'padding-right': 'paddingRight',
  'padding-bottom': 'paddingBottom',
  'padding-left': 'paddingLeft',
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  'margin-top': 'marginTop',
  'margin-right': 'marginRight',
  'margin-bottom': 'marginBottom',
  'margin-left': 'marginLeft',
  gap: 'gap',
  'row-gap': 'rowGap',
  'column-gap': 'columnGap',
} satisfies Record<string, keyof CSSPropertyBag | readonly (keyof CSSPropertyBag)[]>

// Annotated so declaration output names the two schema types instead of
// printing their expanded shape, which does not survive a consumer's
// `exactOptionalPropertyTypes`.
const spacingModule: FrameworkScaleModule<FrameworkSpacingGroup, FrameworkSpacingClassGenerator> = createFrameworkScaleModule({
  family: 'spacing',
  getMinBaseSize: (group) => group.min.size,
  getMaxBaseSize: (group) => group.max.size,
  getMinScaleConfig: (group) => group.min,
  getMaxScaleConfig: (group) => group.max,
  propertyKeymap: PROPERTY_KEYMAP,
  classTags: ['framework', 'utility', 'spacing'],
})

export function generateFrameworkSpacingVariables(
  settings: FrameworkSpacingSettings | null | undefined,
  preferences: Parameters<typeof spacingModule.generateVariables>[1],
) {
  return spacingModule.generateVariables(settings, preferences)
}

export function generateFrameworkSpacingUtilityClasses(
  settings: FrameworkSpacingSettings | null | undefined,
) {
  return spacingModule.generateUtilityClasses(settings)
}

/** Spacing variables + utility classes from a single shared group enumeration. */
export function generateFrameworkSpacingPlan(
  settings: FrameworkSpacingSettings | null | undefined,
  preferences: Parameters<typeof spacingModule.generatePlan>[1],
) {
  return spacingModule.generatePlan(settings, preferences)
}
