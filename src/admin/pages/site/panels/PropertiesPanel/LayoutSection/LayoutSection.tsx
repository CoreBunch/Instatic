/**
 * LayoutSection — visual editor for the `layout-position` CSS section.
 *
 * Replaces the long stack of generic ClassPropertyRow widgets for display /
 * flex / grid / alignment with task-shaped controls (each extracted into its
 * own file in this folder):
 *
 *   • DropdownSwitcher      — connected segmented control [Flex | Grid | ▼ more]
 *                             with no label and no default selection. Choosing a
 *                             segment reveals only the fields relevant to that
 *                             display value.
 *   • FlexDirectionControl  — 4 connected icon buttons (row, column, reverses)
 *   • FlexWrapControl       — 3 segments (Nowrap / Wrap / Wrap-rev)
 *   • AlignmentControl      — connected icon buttons for align-items + justify-
 *                             content; the icon set rotates with flex-direction
 *                             so cross-axis vs main-axis stays visually obvious.
 *   • GridTrackControl      — column / row count picker for grid-template-*
 *   • GridAxisControl       — align-items / justify-items for grid containers
 *   • GapInput              — token-aware text input for `gap`
 *
 * Properties not visualised here (gridTemplate*, position, top/right/bottom/
 * left, zIndex, overflow*) keep using ClassPropertyRow — rendered below the
 * visual switchers so the section still covers every property in
 * `CLASS_STYLE_SECTIONS.layout-position`.
 *
 * Design intent (Job #1342):
 *   - "Nothing chosen by default" — when display is unset, no segment looks
 *     pressed and no flex/grid fields appear. As soon as the user picks
 *     flex (or grid via the dropdown), the dependent rows fade in.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { DisplayFlexGlyph, DisplayGridGlyph } from '@ui/icons/inspectorGlyphs'
import { ClassPropertyRow } from '../ClassPropertyRow'
import { DropdownSwitcher } from '../DropdownSwitcher'
import { getEnumOptions } from '../cssControlTypes'
import { hasStyleValue, readString } from '../styleValueUtils'
import { FlexDirectionControl } from './FlexDirectionControl'
import { FlexWrapControl } from './FlexWrapControl'
import { AlignmentControl } from './AlignmentControl'
import { GapInput } from './GapInput'
import { GridTrackControl } from './GridTrackControl'
import { GridAxisControl } from './GridAxisControl'
import { LabeledControl } from './LabeledControl'
import { PaddingRow } from './PaddingRow'
import styles from '../LayoutSection.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface LayoutSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — used to key sub-controls so they re-mount on tab change. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Applies several properties in one store commit (one undo entry) — the
   *  Padding row writes four sides at once. */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Fully clear a property — removes it from base styles AND from every
   * viewport-context override. Used by the X / clear affordances on the visual
   * switchers so "clear" is unconditional regardless of which viewport
   * tab the user is on. Without this, clearing a viewport-only override
   * would let the inherited base value bleed back through and the switcher
   * segment would stay pressed.
   */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /**
   * Clear several properties in one undo step. Used when clearing `display`
   * must also prune the flex/grid container properties it governed — otherwise
   * they linger as invisible orphans (their controls only render while the
   * matching display is active), leaving the section badge stuck on "N set".
   */
  onClearProperties: (properties: ReadonlyArray<keyof CSSPropertyBag>) => void
  /**
   * Patch-shaped hover-preview channel (see StyleRuleComposer.handlePreview).
   * Forwarded to the display dropdown, the gap token input, and the generic
   * fallback rows so hovering a suggestion previews on the canvas.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

/**
 * Container properties whose visual controls only render while `display` is
 * `flex` or `grid`. When `display` is cleared they would otherwise become
 * invisible orphans — still stored, still counted, but with no row to clear
 * them. Clearing `display` prunes these alongside it. (Item-level properties
 * like `alignSelf` / `justifySelf` / `flex` / `gridColumn` / `gridRow` depend
 * on the PARENT's display, render unconditionally, and are NOT pruned.)
 */
const DISPLAY_DEPENDENT_PROPS: ReadonlyArray<keyof CSSPropertyBag> = [
  'flexDirection',
  'flexWrap',
  'alignItems',
  'justifyContent',
  'justifyItems',
  'gap',
  'rowGap',
  'columnGap',
  'gridTemplateColumns',
  'gridTemplateRows',
]

/**
 * Properties left over after the visual switchers — rendered as generic rows
 * below the switchers. Order follows the original Layout section list, minus
 * the properties owned by the flex block (flexDirection, flexWrap, alignItems,
 * justifyContent, gap — always absent) and the properties owned by the grid
 * block (gridTemplateColumns, gridTemplateRows, justifyItems, gap — likewise
 * never duplicated as fallback rows). The two-axis variants `rowGap` and
 * `columnGap` stay in the fallback for advanced layouts where the user
 * actually needs different row vs column spacing — the visual blocks only
 * surface the unified `gap` shorthand for the common case.
 */
const FALLBACK_PROPS: ReadonlyArray<keyof CSSPropertyBag> = [
  'alignSelf',
  'justifySelf',
  'flex',
  'rowGap',
  'columnGap',
  'gridColumn',
  'gridRow',
]

// ---------------------------------------------------------------------------
// Display switcher config — Flex | Grid + dropdown of every other value
// ---------------------------------------------------------------------------

const DISPLAY_OPTIONS = getEnumOptions('display') ?? ['block']

const DISPLAY_PRIMARY_SEGMENTS = [
  {
    value: 'flex',
    label: 'Flex',
    icon: <DisplayFlexGlyph />,
    ariaLabel: 'Flex layout',
    tooltip: 'display: flex',
  },
  {
    value: 'grid',
    label: 'Grid',
    icon: <DisplayGridGlyph />,
    ariaLabel: 'Grid layout',
    tooltip: 'display: grid',
  },
] as const

// ---------------------------------------------------------------------------
// LayoutSection
// ---------------------------------------------------------------------------

export function LayoutSection({
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onChangeMany,
  onRemove,
  onClearProperty,
  onClearProperties,
  onPreview,
  onClearPreview,
}: LayoutSectionProps) {
  const display = readString(currentStyles, 'display')

  // Clearing display prunes the flex/grid container properties it governed, in
  // one undo step, so the section never reports phantom "N set" orphans.
  const clearDisplayAndDeps = () => onClearProperties(['display', ...DISPLAY_DEPENDENT_PROPS])
  const flexDirection = readString(currentStyles, 'flexDirection') ?? 'row'
  const flexWrap = readString(currentStyles, 'flexWrap')
  const alignItems = readString(currentStyles, 'alignItems')
  const justifyContent = readString(currentStyles, 'justifyContent')

  // Per-property adapter over the patch-shaped preview channel, for the
  // single-property controls in this section (gap input + fallback rows).
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  return (
    <div className={styles.layoutSection}>
      {/* Display switcher — labeled "Type" like the redesign's Layout row */}
      <LabeledControl label="Type" isSet={hasStyleValue(storedStyles.display)}>
        <DropdownSwitcher
          property="display"
          value={display}
          primarySegments={DISPLAY_PRIMARY_SEGMENTS}
          allOptions={DISPLAY_OPTIONS}
          onChange={(v) => onChange('display', v)}
          onClear={clearDisplayAndDeps}
          onPreview={onPreview ? (v) => onPreview({ display: v } as Partial<CSSPropertyBag>) : undefined}
          onClearPreview={onClearPreview}
        />
      </LabeledControl>

      {/* Flex-only fields, revealed when display === 'flex' */}
      {display === 'flex' && (
        <div className={styles.flexBlock}>
          <FlexDirectionControl
            value={flexDirection}
            isSet={hasStyleValue(storedStyles.flexDirection)}
            onChange={(v) => onChange('flexDirection', v)}
            onClear={() => onClearProperty('flexDirection')}
          />
          <FlexWrapControl
            value={flexWrap}
            isSet={hasStyleValue(storedStyles.flexWrap)}
            onChange={(v) => onChange('flexWrap', v)}
            onClear={() => onClearProperty('flexWrap')}
          />
          <AlignmentControl
            axis="cross"
            flexDirection={flexDirection}
            value={alignItems}
            isSet={hasStyleValue(storedStyles.alignItems)}
            onChange={(v) => onChange('alignItems', v)}
            onClear={() => onClearProperty('alignItems')}
            label="Align"
          />
          <AlignmentControl
            axis="main"
            flexDirection={flexDirection}
            value={justifyContent}
            isSet={hasStyleValue(storedStyles.justifyContent)}
            onChange={(v) => onChange('justifyContent', v)}
            onClear={() => onClearProperty('justifyContent')}
            label="Justify"
          />
          <GapInput
            value={readString(currentStyles, 'gap')}
            isSet={hasStyleValue(storedStyles.gap)}
            onChange={(v) => onChange('gap', v)}
            onPreview={onPreview ? (v) => onPreview({ gap: v ?? null } as Partial<CSSPropertyBag>) : undefined}
            onClearPreview={onClearPreview}
          />
          <PaddingRow
            currentStyles={currentStyles}
            storedStyles={storedStyles}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </div>
      )}

      {/* Grid-only fields, revealed when display === 'grid' */}
      {display === 'grid' && (
        <div className={styles.flexBlock}>
          <GridTrackControl
            label="Columns"
            ariaLabel="Grid template columns"
            value={readString(currentStyles, 'gridTemplateColumns')}
            isSet={hasStyleValue(storedStyles.gridTemplateColumns)}
            onChange={(v) => onChange('gridTemplateColumns', v)}
            onClear={() => onClearProperty('gridTemplateColumns')}
          />
          <GridTrackControl
            label="Rows"
            ariaLabel="Grid template rows"
            value={readString(currentStyles, 'gridTemplateRows')}
            isSet={hasStyleValue(storedStyles.gridTemplateRows)}
            onChange={(v) => onChange('gridTemplateRows', v)}
            onClear={() => onClearProperty('gridTemplateRows')}
          />
          <GridAxisControl
            label="Align"
            axis="block"
            value={alignItems}
            isSet={hasStyleValue(storedStyles.alignItems)}
            onChange={(v) => onChange('alignItems', v)}
            onClear={() => onClearProperty('alignItems')}
          />
          <GridAxisControl
            label="Justify"
            axis="inline"
            value={readString(currentStyles, 'justifyItems')}
            isSet={hasStyleValue(storedStyles.justifyItems)}
            onChange={(v) => onChange('justifyItems', v)}
            onClear={() => onClearProperty('justifyItems')}
          />
          <GapInput
            value={readString(currentStyles, 'gap')}
            isSet={hasStyleValue(storedStyles.gap)}
            onChange={(v) => onChange('gap', v)}
            onPreview={onPreview ? (v) => onPreview({ gap: v ?? null } as Partial<CSSPropertyBag>) : undefined}
            onClearPreview={onClearPreview}
          />
          <PaddingRow
            currentStyles={currentStyles}
            storedStyles={storedStyles}
            onChange={onChange}
            onChangeMany={onChangeMany}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </div>
      )}

      {/* Long-tail item-level properties (align-self / flex / grid placement,
          per-axis gaps) appear only once SET — the section header's "+" is
          how they get added. A set value renders regardless of display so
          nothing stored ever hides without a row to clear it. */}
      {FALLBACK_PROPS.filter((prop) => hasStyleValue(storedStyles[prop])).map((prop) => (
        <ClassPropertyRow
          key={`${activeTab}-${String(prop)}`}
          property={prop}
          value={storedStyles[prop] as string | number}
          isSet
          removable
          onChange={onChange}
          onRemove={onRemove}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      ))}
    </div>
  )
}
