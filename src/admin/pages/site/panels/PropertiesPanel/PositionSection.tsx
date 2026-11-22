import type { IconComponent } from 'pixel-art-icons/types'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ArrowBarUpIcon } from 'pixel-art-icons/icons/arrow-bar-up'
import { ArrowBarRightIcon } from 'pixel-art-icons/icons/arrow-bar-right'
import { ArrowBarDownIcon } from 'pixel-art-icons/icons/arrow-bar-down'
import { ArrowBarLeftIcon } from 'pixel-art-icons/icons/arrow-bar-left'
import { ClassPropertyRow } from './ClassPropertyRow'
import { Select } from '@ui/components/Select'
import { LabeledControl } from './LayoutSection/LabeledControl'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens, type Token } from '@site/property-controls/tokenUtils'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue, readString } from './styleValueUtils'
import styles from './LayoutSection.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface PositionSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — used to key sub-controls so they re-mount on tab change. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /** Fully clear a property — see StyleRuleComposer.handleClearProperty. */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  /**
   * Patch-shaped hover-preview channel (see StyleRuleComposer.handlePreview).
   * Forwarded to the position dropdown, the offset token inputs, and the
   * z-index row so hovering a suggestion previews on the canvas.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

/** Position values that honor top/right/bottom/left and reveal the
 *  directions block. `static` is intentionally excluded because static
 *  elements ignore those offsets. */
const POSITIONED_VALUES = new Set(['relative', 'absolute', 'fixed', 'sticky'])

// ---------------------------------------------------------------------------
// PositionSection
// ---------------------------------------------------------------------------

export function PositionSection({
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onRemove,
  onClearProperty,
  onPreview,
  onClearPreview,
}: PositionSectionProps) {
  const hoverPreview = useEditorPreference('hoverPreview')
  const position = readString(currentStyles, 'position')
  const options = position && !POSITION_OPTIONS.some((option) => option === position)
    ? [...POSITION_OPTIONS, position] : POSITION_OPTIONS
  const positionIsActive = position != null && POSITIONED_VALUES.has(position)

  // Per-property adapter over the patch-shaped preview channel, used by the
  // offset token inputs and the z-index row (each owns a single property).
  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  const zIndexStored = storedStyles.zIndex
  const zIndexIsSet = hasStyleValue(zIndexStored)
  const zIndexCurrent = currentStyles.zIndex
  const zIndexFallback = hasStyleValue(zIndexCurrent)
    ? zIndexCurrent
    : getCSSPropertyDefaultValue('zIndex')

  // Spacing tokens drive the autocomplete dropdown on each offset input —
  // same vocabulary the SpacingBoxControl side inputs use, surfaced via
  // the shared TokenAwareInput primitive.
  const spacingTokens = useSpacingTokens()

  return (
    <>
      <LabeledControl label="Type" isSet={hasStyleValue(storedStyles.position)}>
        <Select
          fieldSize="sm"
          aria-label="Position type"
          data-testid="css-position-switcher"
          value={position ?? ''}
          onChange={(event) => event.target.value ? onChange('position', event.target.value) : onClearProperty('position')}
          onOptionPreview={hoverPreview && onPreview ? (value) => onPreview({ position: value || 'static' } as Partial<CSSPropertyBag>) : undefined}
          onOptionPreviewClear={onClearPreview}
        >
          <option value="">Default</option>
          {options.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
      </LabeledControl>
      {positionIsActive && (
        <div className={styles.positionDirectionsGrid}>
          <DirectionInput
            property="top"
            icon={ArrowBarUpIcon}
            ariaLabel="Top offset"
            storedValue={storedStyles.top}
            currentValue={currentStyles.top}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
          <DirectionInput
            property="right"
            icon={ArrowBarRightIcon}
            ariaLabel="Right offset"
            storedValue={storedStyles.right}
            currentValue={currentStyles.right}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
          <DirectionInput
            property="bottom"
            icon={ArrowBarDownIcon}
            ariaLabel="Bottom offset"
            storedValue={storedStyles.bottom}
            currentValue={currentStyles.bottom}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
          <DirectionInput
            property="left"
            icon={ArrowBarLeftIcon}
            ariaLabel="Left offset"
            storedValue={storedStyles.left}
            currentValue={currentStyles.left}
            tokens={spacingTokens}
            onChange={onChange}
            onClear={onClearProperty}
            onPreview={previewProperty}
            onClearPreview={onClearPreview}
          />
        </div>
      )}
      {/* z-index row — always visible inside the section. Stacking context
          can matter even on otherwise non-positioned elements (e.g. flex
          items, grid items) so the row stays available regardless of the
          current position keyword. */}
      <ClassPropertyRow
        key={`${activeTab}-zIndex`}
        property="zIndex"
        value={zIndexIsSet ? (zIndexStored as string | number) : undefined}
        placeholder={!zIndexIsSet ? zIndexFallback : undefined}
        isSet={zIndexIsSet}
        onChange={onChange}
        onRemove={onRemove}
        onPreview={previewProperty}
        onClearPreview={onClearPreview}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Position switcher config — Relative | Absolute + dropdown of every value
// ---------------------------------------------------------------------------

const POSITION_OPTIONS = ['static', 'relative', 'absolute', 'fixed', 'sticky'] as const

// ---------------------------------------------------------------------------
// DirectionInput — icon-as-label numeric/text input for top/right/bottom/left
// ---------------------------------------------------------------------------

interface DirectionInputProps {
  property: keyof CSSPropertyBag
  icon: IconComponent
  ariaLabel: string
  storedValue: unknown
  currentValue: unknown
  /** Spacing tokens to suggest in the autocomplete dropdown. */
  tokens: ReadonlyArray<Token>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClear: (property: keyof CSSPropertyBag) => void
  /** Per-property hover / as-you-type preview adapter. */
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function DirectionInput({
  property,
  icon: DirectionIcon,
  ariaLabel,
  storedValue,
  currentValue,
  tokens,
  onChange,
  onClear,
  onPreview,
  onClearPreview,
}: DirectionInputProps) {
  const isSet = hasStyleValue(storedValue)
  const placeholder = !isSet
    ? hasStyleValue(currentValue)
      ? String(currentValue)
      : 'auto'
    : undefined

  return (
    <div
      className={styles.directionCell}
      data-state={isSet ? 'set' : 'unset'}
      data-testid={`css-direction-input-${String(property)}`}
    >
      <span className={styles.directionIcon} aria-hidden="true">
        <DirectionIcon size={14} />
      </span>
      <TokenAwareInput adjustable
        aria-label={ariaLabel}
        value={isSet ? String(storedValue) : undefined}
        placeholder={placeholder}
        tokens={tokens}
        onCommit={(resolved) => onChange(property, resolved)}
        onPreview={onPreview ? (resolved) => onPreview(property, resolved) : undefined}
        onClearPreview={onClearPreview}
        className={styles.directionInput}
      />
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label={`Clear ${ariaLabel}`}
          tooltip={`Clear ${ariaLabel.toLowerCase()}`}
          onClick={() => onClear(property)}
          className={styles.directionClearBtn}
        >
          <CloseIcon size={12} color="currentColor" />
        </Button>
      )}
    </div>
  )
}

