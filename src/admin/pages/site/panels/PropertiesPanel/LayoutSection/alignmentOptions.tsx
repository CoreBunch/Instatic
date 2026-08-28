/**
 * alignmentOptions — the axis-aware icon option sets shared by the Flex
 * `AlignmentControl` and the Grid `GridAxisControl`.
 *
 * The icon set is keyed off the *main-axis* orientation:
 *   - direction: row | row-reverse        → main is horizontal, cross is vertical
 *   - direction: column | column-reverse  → main is vertical,   cross is horizontal
 * Both MAIN and CROSS arrays are named after the direction items flow
 * (i.e. the main axis), so callers just pick the matching pair.
 *
 * The same `flex-start | center | flex-end | stretch | baseline` value
 * keywords work in both flex and grid containers per CSS Box Alignment
 * Module 3, so keeping these arrays in one place is what lets Flex and Grid
 * speak the same visual language.
 *
 * Marks come from `@ui/icons/inspectorGlyphs` — the hairline family the
 * inspector redesign draws for its icon rows. There are only two geometric
 * families here: "align along the vertical axis" (a rule at top / middle /
 * bottom + an upright box) and "align along the horizontal axis" (a rule at
 * left / centre / right + a wide box). Each axis picks the family that
 * matches the direction it aligns in, which is why the same glyph appears in
 * both a CROSS and a MAIN array.
 */

import {
  AlignStartGlyph,
  AlignCenterGlyph,
  AlignEndGlyph,
  AlignStretchGlyph,
  AlignStretchHorizontalGlyph,
  AlignBaselineGlyph,
  JustifyStartGlyph,
  JustifyCenterGlyph,
  JustifyEndGlyph,
  JustifySpaceBetweenGlyph,
  JustifySpaceBetweenVerticalGlyph,
  JustifySpaceAroundGlyph,
  JustifySpaceAroundVerticalGlyph,
} from '@ui/icons/inspectorGlyphs'

/**
 * Cross-axis (alignItems) icon set when items flow horizontally — items align
 * along the vertical (cross) axis, so this is the top / middle / bottom family.
 */
export const CROSS_HORIZONTAL_OPTIONS = [
  {
    value: 'flex-start',
    icon: <AlignStartGlyph />,
    ariaLabel: 'Align start',
    tooltip: 'align-items: flex-start',
  },
  {
    value: 'center',
    icon: <AlignCenterGlyph />,
    ariaLabel: 'Align center',
    tooltip: 'align-items: center',
  },
  {
    value: 'flex-end',
    icon: <AlignEndGlyph />,
    ariaLabel: 'Align end',
    tooltip: 'align-items: flex-end',
  },
  {
    value: 'stretch',
    icon: <AlignStretchGlyph />,
    ariaLabel: 'Align stretch',
    tooltip: 'align-items: stretch',
  },
  {
    value: 'baseline',
    icon: <AlignBaselineGlyph />,
    ariaLabel: 'Align baseline',
    tooltip: 'align-items: baseline',
  },
] as const

/** Cross-axis when items flow vertically — items align along the horizontal axis. */
export const CROSS_VERTICAL_OPTIONS = [
  {
    value: 'flex-start',
    icon: <JustifyStartGlyph />,
    ariaLabel: 'Align start',
    tooltip: 'align-items: flex-start',
  },
  {
    value: 'center',
    icon: <JustifyCenterGlyph />,
    ariaLabel: 'Align center',
    tooltip: 'align-items: center',
  },
  {
    value: 'flex-end',
    icon: <JustifyEndGlyph />,
    ariaLabel: 'Align end',
    tooltip: 'align-items: flex-end',
  },
  {
    value: 'stretch',
    icon: <AlignStretchHorizontalGlyph />,
    ariaLabel: 'Align stretch',
    tooltip: 'align-items: stretch',
  },
  {
    value: 'baseline',
    icon: <AlignBaselineGlyph />,
    ariaLabel: 'Align baseline',
    tooltip: 'align-items: baseline',
  },
] as const

/**
 * Main-axis (justifyContent) icon set when items flow horizontally — they
 * justify along the horizontal axis, so this is the left / centre / right
 * family the prototype draws for its full-width icon row.
 */
export const MAIN_HORIZONTAL_OPTIONS = [
  {
    value: 'flex-start',
    icon: <JustifyStartGlyph />,
    ariaLabel: 'Justify start',
    tooltip: 'justify-content: flex-start',
  },
  {
    value: 'center',
    icon: <JustifyCenterGlyph />,
    ariaLabel: 'Justify center',
    tooltip: 'justify-content: center',
  },
  {
    value: 'flex-end',
    icon: <JustifyEndGlyph />,
    ariaLabel: 'Justify end',
    tooltip: 'justify-content: flex-end',
  },
  {
    value: 'space-between',
    icon: <JustifySpaceBetweenGlyph />,
    ariaLabel: 'Space between',
    tooltip: 'justify-content: space-between',
  },
  {
    value: 'space-around',
    icon: <JustifySpaceAroundGlyph />,
    ariaLabel: 'Space around',
    tooltip: 'justify-content: space-around',
  },
] as const

/** Main-axis when items flow vertically — they justify along the vertical axis. */
export const MAIN_VERTICAL_OPTIONS = [
  {
    value: 'flex-start',
    icon: <AlignStartGlyph />,
    ariaLabel: 'Justify start',
    tooltip: 'justify-content: flex-start',
  },
  {
    value: 'center',
    icon: <AlignCenterGlyph />,
    ariaLabel: 'Justify center',
    tooltip: 'justify-content: center',
  },
  {
    value: 'flex-end',
    icon: <AlignEndGlyph />,
    ariaLabel: 'Justify end',
    tooltip: 'justify-content: flex-end',
  },
  {
    value: 'space-between',
    icon: <JustifySpaceBetweenVerticalGlyph />,
    ariaLabel: 'Space between',
    tooltip: 'justify-content: space-between',
  },
  {
    value: 'space-around',
    icon: <JustifySpaceAroundVerticalGlyph />,
    ariaLabel: 'Space around',
    tooltip: 'justify-content: space-around',
  },
] as const
