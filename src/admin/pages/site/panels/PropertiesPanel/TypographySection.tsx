/**
 * TypographySection — visual editor for the `typography` CSS section
 * (inspector redesign). Curated rows in the mock-up's order:
 *
 *   • Font    — family picker (FontFamilyControl via ClassPropertyRow).
 *   • Weight  — weight select, options narrowed to the active family.
 *   • Size    — fontSize ⊕ lineHeight as one two-cell row ("48 | 1.1 lh"),
 *               fontSize with typography-token autocomplete.
 *   • Spacing — letterSpacing.
 *   • Align   — text-align as a fused four-icon button group.
 *   • Color   — text colour swatch row.
 *
 * The long tail (fontStyle, textDecoration, textTransform, whiteSpace,
 * textShadow) lives behind the shared Advanced disclosure.
 */

import type { CSSPropertyBag } from '@core/page-tree'
import { ControlRow } from '@ui/components/ControlRow'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import {
  TextAlignCenterGlyph,
  TextAlignJustifyGlyph,
  TextAlignLeftGlyph,
  TextAlignRightGlyph,
} from '@ui/icons/inspectorGlyphs'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useTypographyTokens } from '@site/property-controls/tokenUtils'
import { ClassPropertyRow } from './ClassPropertyRow'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue, stepCssLength } from './styleValueUtils'
import styles from './TypographySection.module.css'

const PRIMARY_ROWS: ReadonlyArray<{ prop: keyof CSSPropertyBag; label?: string }> = [
  { prop: 'fontFamily', label: 'Font' },
  { prop: 'fontWeight', label: 'Weight' },
]

/* Prototype's text-align button group: four hairline marks, in this order. */
const ALIGN_OPTIONS = [
  { value: 'left', ariaLabel: 'Align left', tooltip: 'left', icon: <TextAlignLeftGlyph /> },
  { value: 'center', ariaLabel: 'Align center', tooltip: 'center', icon: <TextAlignCenterGlyph /> },
  { value: 'right', ariaLabel: 'Align right', tooltip: 'right', icon: <TextAlignRightGlyph /> },
  { value: 'justify', ariaLabel: 'Justify', tooltip: 'justify', icon: <TextAlignJustifyGlyph /> },
] as const

const ADVANCED_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'fontStyle',
  'textDecoration',
  'textTransform',
  'whiteSpace',
  'textShadow',
]

interface TypographySectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — the parent keys this component on it. */
  activeTab: string
  /**
   * The section's property list AFTER search filtering (the parent passes the
   * filtered section definition), so a style search narrows this section
   * like any generic one.
   */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function TypographySection({
  currentStyles,
  storedStyles,
  activeTab,
  visibleProperties,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: TypographySectionProps) {
  const visible = new Set<keyof CSSPropertyBag>(visibleProperties)
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  /** `removable` marks a row that arrived from the section's "+" (§5 rule 1). */
  const renderRow = (
    prop: keyof CSSPropertyBag,
    labelOverride?: string,
    removable = false,
  ) => {
    if (!visible.has(prop)) return null
    const storedValue = storedStyles[prop]
    const isSet = hasStyleValue(storedValue)
    const currentValue = currentStyles[prop]
    const fallbackValue = hasStyleValue(currentValue)
      ? currentValue
      : getCSSPropertyDefaultValue(prop)
    return (
      <ClassPropertyRow
        key={`${activeTab}-${String(prop)}`}
        property={prop}
        value={isSet ? (storedValue as string | number) : undefined}
        placeholder={!isSet ? fallbackValue : undefined}
        labelOverride={labelOverride}
        fontFamilyValue={currentStyles.fontFamily}
        isSet={isSet}
        removable={removable}
        onChange={onChange}
        onRemove={onRemove}
        onPreview={previewProperty}
        onClearPreview={onClearPreview}
      />
    )
  }

  const advancedVisible = ADVANCED_PROPERTIES.filter((prop) => visible.has(prop))

  return (
    <>
      {PRIMARY_ROWS.map(({ prop, label }) => renderRow(prop, label))}
      {(visible.has('fontSize') || visible.has('lineHeight')) && (
        <SizeRow
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          onChange={onChange}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      )}
      {renderRow('letterSpacing', 'Spacing')}
      {visible.has('textAlign') && (
        <AlignRow
          storedValue={storedStyles.textAlign}
          currentValue={currentStyles.textAlign}
          onChange={onChange}
          onRemove={onRemove}
        />
      )}
      {renderRow('color', 'Color')}
      {/* Long-tail rows appear only once SET — the section header's "+" is
          how they get added. */}
      {advancedVisible
        .filter((prop) => hasStyleValue(storedStyles[prop]))
        .map((prop) => renderRow(prop, undefined, true))}
    </>
  )
}

// ---------------------------------------------------------------------------
// SizeRow — fontSize ⊕ lineHeight in one two-cell row
// ---------------------------------------------------------------------------

interface SizeRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function SizeRow({ storedStyles, currentStyles, onChange, onPreview, onClearPreview }: SizeRowProps) {
  const typographyTokens = useTypographyTokens()
  const sizeSet = hasStyleValue(storedStyles.fontSize)
  const lineHeightSet = hasStyleValue(storedStyles.lineHeight)
  const isSet = sizeSet || lineHeightSet

  const cellValue = (prop: 'fontSize' | 'lineHeight', set: boolean) =>
    set ? String(storedStyles[prop]) : undefined
  const cellPlaceholder = (prop: 'fontSize' | 'lineHeight', set: boolean) => {
    if (set) return undefined
    const current = currentStyles[prop]
    return hasStyleValue(current) ? String(current) : String(getCSSPropertyDefaultValue(prop))
  }

  return (
    <ControlRow label="Size" isSet={isSet}>
      <div className={styles.duo}>
        <div data-testid="css-property-row-fontSize">
          <TokenAwareInput
            aria-label="Font size"
            value={cellValue('fontSize', sizeSet)}
            placeholder={cellPlaceholder('fontSize', sizeSet)}
            tokens={typographyTokens}
            onCommit={(resolved) => onChange('fontSize', resolved)}
            stepValue={(current, delta) => stepCssLength(current || '16px', delta)}
            onPreview={onPreview ? (resolved) => onPreview('fontSize', resolved) : undefined}
            onClearPreview={onClearPreview}
          />
        </div>
        <div className={styles.tagCell} data-testid="css-property-row-lineHeight">
          <TokenAwareInput
            aria-label="Line height"
            value={cellValue('lineHeight', lineHeightSet)}
            placeholder={cellPlaceholder('lineHeight', lineHeightSet)}
            tokens={[]}
            // A bare line-height IS the value (`1.5` = 1.5× the font size);
            // the stepper below keeps it unitless, so the typed path must too.
            implicitUnit=""
            onCommit={(resolved) => onChange('lineHeight', resolved)}
            stepValue={(current, delta) => {
              // Unitless line heights step in tenths — whole numbers would
              // jump from 1.5 straight past every value an author wants.
              const base = current || '1.5'
              const unitless = /^-?\d*\.?\d+$/.test(base.trim())
              return unitless
                ? String(Math.max(0, Math.round((Number(base) + delta * 0.1) * 100) / 100))
                : stepCssLength(base, delta)
            }}
            onPreview={onPreview ? (resolved) => onPreview('lineHeight', resolved) : undefined}
            onClearPreview={onClearPreview}
          />
          <span className={styles.cellTag} aria-hidden="true">lh</span>
        </div>
      </div>
    </ControlRow>
  )
}

// ---------------------------------------------------------------------------
// AlignRow — text-align as the prototype's fused four-icon button group
// ---------------------------------------------------------------------------

interface AlignRowProps {
  storedValue: unknown
  currentValue: unknown
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
}

function AlignRow({ storedValue, currentValue, onChange, onRemove }: AlignRowProps) {
  const isSet = hasStyleValue(storedValue)
  const effective = String(
    (isSet ? storedValue : hasStyleValue(currentValue) ? currentValue : getCSSPropertyDefaultValue('textAlign')) ?? '',
  )
  const pressed = ALIGN_OPTIONS.find((option) => option.value === effective)?.value

  return (
    <ControlRow label="Align" isSet={isSet} testId="css-property-row-textAlign">
      <SegmentedControl
        look="tiles"
        fullWidth
        aria-label="Text align"
        value={pressed}
        options={ALIGN_OPTIONS}
        onChange={(next) => onChange('textAlign', next)}
        onClear={isSet ? () => onRemove('textAlign') : undefined}
      />
    </ControlRow>
  )
}
