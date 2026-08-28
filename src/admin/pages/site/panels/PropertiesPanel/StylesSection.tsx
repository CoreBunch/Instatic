/**
 * StylesSection — visual editor for the unified `styles` CSS section
 * (inspector redesign). One section owns the element's visual surface, in the
 * mock-up's row order:
 *
 *   • Opacity   — number field + slider, both on the shared control height.
 *                 The slider previews while dragging and commits on release,
 *                 so a drag is one undo entry.
 *   • Visible   — Yes / No segmented pair on `visibility` (visible/hidden).
 *                 Clicking the pressed segment clears the property.
 *   • Fill      — the unified fill row (`backgroundColor` + gradient routing
 *                 to `backgroundImage`, via BackgroundFillControl).
 *   • Image     — `backgroundImage` (None / Image picker / Custom).
 *   • Overflow  — enum select.
 *   • Radius    — corner longhands with an all-corners / per-corner scope
 *                 pair; per-corner mode reveals four cells.
 *   • Border    — the visual BorderControl (edge box + per-side longhands,
 *                 outline).
 *
 * The long tail (background longhands, object-fit, per-axis overflow, border
 * shorthands, appearance) stays reachable behind the shared Advanced
 * disclosure — same pattern as the Size section.
 */

import { useState, type CSSProperties } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Input } from '@ui/components/Input'
import { PerCornerGlyph } from '@ui/icons/inspectorGlyphs'
import { ScopeGroup, type ScopeMode } from './ScopeGroup'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { BorderPopoutRow } from './BorderControl/BorderPopoutRow'
import { ClassPropertyRow } from './ClassPropertyRow'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue, readString, stepCssLength } from './styleValueUtils'
import styles from './StylesSection.module.css'

const ADVANCED_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'backgroundSize',
  'backgroundPosition',
  'backgroundRepeat',
  'objectFit',
  'objectPosition',
  'overflowX',
  'overflowY',
  'border',
  'borderTop',
  'borderRight',
  'borderBottom',
  'borderLeft',
  'borderWidth',
  'borderStyle',
  'borderColor',
  'appearance',
]

interface StylesSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — the parent keys this component on it. */
  activeTab: string
  /**
   * The section's property list AFTER search filtering (the parent passes the
   * filtered section definition). Rows whose property was filtered out don't
   * render, so a style search narrows this section like any generic one.
   */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Applies several properties in one store commit (one undo entry). */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /** Fully clear a property across base + all breakpoints (switcher semantics). */
  onClearProperty: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function StylesSection({
  currentStyles,
  storedStyles,
  activeTab,
  visibleProperties,
  onChange,
  onChangeMany,
  onRemove,
  onClearProperty,
  onPreview,
  onClearPreview,
}: StylesSectionProps) {
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
        backgroundImageValue={currentStyles.backgroundImage}
        isSet={isSet}
        removable={removable}
        onChange={onChange}
        onChangeMany={onChangeMany}
        onRemove={onRemove}
        onPreview={previewProperty}
        onClearPreview={onClearPreview}
      />
    )
  }

  const advancedVisible = ADVANCED_PROPERTIES.filter((prop) => visible.has(prop))
  // The Border block edits per-side longhands + per-corner radius + outline;
  // it stays visible while any of those survive the search filter.
  const borderVisible = visibleProperties.some(
    (prop) => String(prop).startsWith('border') || prop === 'outline' || prop === 'outlineOffset',
  )
  // The trigger row's dot follows the same rule as every other row: any
  // stored border longhand makes it "set".
  const borderIsSet = Object.keys(storedStyles).some(
    (key) => key.startsWith('border') && !key.startsWith('borderRadius') && hasStyleValue(storedStyles[key]),
  )

  return (
    <>
      {visible.has('opacity') && (
        <OpacityRow
          storedValue={storedStyles.opacity}
          currentValue={currentStyles.opacity}
          onChange={onChange}
          onRemove={onRemove}
          onPreview={onPreview}
          onClearPreview={onClearPreview}
        />
      )}
      {visible.has('visibility') && (
        <VisibleRow
          stored={hasStyleValue(storedStyles.visibility)}
          value={readString(currentStyles, 'visibility')}
          onChange={onChange}
          onClearProperty={onClearProperty}
        />
      )}
      {renderRow('backgroundColor', 'Fill')}
      {renderRow('backgroundImage', 'Image')}
      {renderRow('overflow')}
      {visible.has('borderRadius') && (
        <RadiusRow
          key={`${activeTab}-radius`}
          storedStyles={storedStyles}
          currentStyles={currentStyles}
          onChange={onChange}
          onClearProperty={onClearProperty}
        />
      )}
      {borderVisible && (
        <div className={styles.row} data-state={borderIsSet ? 'set' : 'unset'}>
          <RowLabel label="Border" isSet={borderIsSet} />
          <BorderPopoutRow
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            activeTab={activeTab}
            onChange={onChange}
            onClearProperty={onClearProperty}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </div>
      )}
      {/* Long-tail rows appear only once SET — the section header's "+" is
          how they get added. */}
      {advancedVisible
        .filter((prop) => hasStyleValue(storedStyles[prop]))
        .map((prop) => renderRow(prop, undefined, true))}
    </>
  )
}

// ---------------------------------------------------------------------------
// OpacityRow — number field + slider on one row (previews while dragging,
// commits once on release so a drag is a single undo entry)
// ---------------------------------------------------------------------------

interface OpacityRowProps {
  storedValue: unknown
  currentValue: unknown
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

function parseOpacity(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp01(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return clamp01(parsed)
  }
  return null
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function OpacityRow({
  storedValue,
  currentValue,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: OpacityRowProps) {
  const isSet = hasStyleValue(storedValue)
  const effective = parseOpacity(isSet ? storedValue : currentValue) ?? 1
  // Slider drags preview live and commit once on release.
  const [dragValue, setDragValue] = useState<number | null>(null)
  // The text field keeps lexical drafts (`0.`, empty) while focused.
  const [draft, setDraft] = useState<string | null>(null)

  const shown = dragValue ?? effective

  const commitNumber = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (isSet) onRemove('opacity')
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) onChange('opacity', clamp01(parsed))
  }

  return (
    <div
      className={styles.row}
      data-state={isSet ? 'set' : 'unset'}
      data-testid="css-property-row-opacity"
    >
      <RowLabel label="Opacity" isSet={isSet} />
      <div className={styles.opacityPair}>
        <Input
          // Numeric field, not `type="number"`: a controlled number input
          // sanitises every partial decimal (`0.`) to an empty string, which
          // would wipe the value mid-keystroke. `inputMode` gives the numeric
          // keypad and the stepper the numeric affordances — the prototype's
          // `.numberfield` is a text input for the same reason.
          inputMode="decimal"
          aria-label="Opacity"
          fieldSize="sm"
          value={draft ?? String(shown)}
          onStep={(delta) => onChange('opacity', clamp01(roundTo2(effective + delta * 0.1)))}
          onFocus={() => setDraft(isSet ? String(effective) : '')}
          onChange={(event) => {
            // The draft keeps lexical states (`0.`, empty) while finite values
            // persist immediately as numbers — same contract as the generic
            // number-typed property rows.
            const next = event.target.value
            setDraft(next)
            commitNumber(next)
          }}
          onBlur={(event) => {
            commitNumber(event.target.value)
            setDraft(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
        <input
          type="range"
          className={styles.opacitySlider}
          style={{ '--opacity-progress': `${shown * 100}%` } as CSSProperties}
          aria-label="Opacity slider"
          min={0}
          max={1}
          step={0.01}
          value={shown}
          onChange={(event) => {
            const next = clamp01(Number(event.target.value))
            setDragValue(next)
            onPreview?.({ opacity: next })
          }}
          onPointerUp={() => {
            if (dragValue !== null) {
              onClearPreview?.()
              onChange('opacity', dragValue)
              setDragValue(null)
            }
          }}
          onKeyUp={() => {
            if (dragValue !== null) {
              onClearPreview?.()
              onChange('opacity', dragValue)
              setDragValue(null)
            }
          }}
          onBlur={() => {
            // Safety: a drag interrupted without pointerup (e.g. Escape) must
            // not leave a stale preview on the canvas.
            if (dragValue !== null) {
              onClearPreview?.()
              setDragValue(null)
            }
          }}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// VisibleRow — Yes / No pair on `visibility`
// ---------------------------------------------------------------------------

interface VisibleRowProps {
  /** Whether `visibility` is explicitly stored on the editing target. */
  stored: boolean
  /** Effective value (base-merged), for the pressed state. */
  value: string | undefined
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
}

const VISIBLE_OPTIONS = [
  { value: 'visible', label: 'Yes' },
  { value: 'hidden', label: 'No' },
] as const

function VisibleRow({ stored, value, onChange, onClearProperty }: VisibleRowProps) {
  return (
    <div className={styles.row} data-state={stored ? 'set' : 'unset'}>
      <RowLabel label="Visible" isSet={stored} />
      <SegmentedControl
        fullWidth
        aria-label="Visibility"
        value={value === 'visible' || value === 'hidden' ? value : undefined}
        options={VISIBLE_OPTIONS}
        onChange={(next) => onChange('visibility', next)}
        onClear={() => onClearProperty('visibility')}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// RowLabel — prototype `.row > .label`: constant tone, accent dot when set
// ---------------------------------------------------------------------------

function RowLabel({ label, isSet }: { label: string; isSet: boolean }) {
  return (
    <span className={styles.rowLabel}>
      {isSet && <span className={styles.rowDot} aria-hidden="true" />}
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// RadiusRow — value field ⊕ all-corners / per-corner scope
// ---------------------------------------------------------------------------

const CORNERS = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const
/* Letters under the four fields, clockwise from the top-left corner. */
const CORNER_TAGS = ['TL', 'TR', 'BR', 'BL'] as const
type Corner = (typeof CORNERS)[number]

function cornerKey(corner: Corner): keyof CSSPropertyBag {
  return `border${corner}Radius` as keyof CSSPropertyBag
}

function cornerLabel(corner: Corner): string {
  return corner.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

function readCornerValue(bag: Record<string, unknown>, corner: Corner): string {
  const raw = bag[cornerKey(corner)]
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number') return `${raw}px`
  return ''
}


function roundTo2(n: number): number {
  return Math.round(n * 100) / 100
}



interface RadiusRowProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearProperty: (property: keyof CSSPropertyBag) => void
}

function RadiusRow({ storedStyles, currentStyles, onChange, onClearProperty }: RadiusRowProps) {
  const tokens = useSpacingTokens()
  const stored = CORNERS.map((corner) => readCornerValue(storedStyles, corner))
  const anySet = stored.some((value) => value !== '')
  const uniform = anySet && stored.every((value) => value === stored[0])

  const [scope, setScope] = useState<ScopeMode>(() => (uniform || !anySet ? 'all' : 'parts'))
  // Auto-relink when an external edit brings the corners back to one value;
  // never auto-split — that stays a deliberate user action.
  if (scope === 'parts' && uniform) setScope('all')

  const fallback = (corner: Corner) =>
    readCornerValue(currentStyles, corner) ||
    (typeof currentStyles.borderRadius === 'string' ? currentStyles.borderRadius : '') ||
    '0'

  const writeAll = (value: string | undefined) => {
    for (const corner of CORNERS) onChange(cornerKey(corner), value)
    // The shorthand would otherwise shadow the longhands the control writes.
    if (hasStyleValue(storedStyles.borderRadius)) onClearProperty('borderRadius')
  }

  const linkedValue = stored[0]
  const linkedPlaceholder = fallback('TopLeft')

  return (
    <ScopeGroup
      testId="css-radius-row"
      isSet={anySet}
      label={<RowLabel label="Radius" isSet={anySet} />}
      mode={scope}
      scopeAriaLabel="Radius scope"
      allAriaLabel="All corners"
      partsAriaLabel="Corner separately"
      partsIcon={<PerCornerGlyph />}
      linked={
        <TokenAwareInput
          aria-label="Radius"
          value={linkedValue || undefined}
          placeholder={linkedPlaceholder}
          tokens={tokens}
          disabled={scope === 'parts'}
          onCommit={(resolved) => writeAll(resolved)}
          onStep={(delta) => {
            const next = stepCssLength(linkedValue || linkedPlaceholder, delta)
            if (next) writeAll(next)
          }}
        />
      }
      parts={CORNERS.map((corner, index) => ({
        tag: CORNER_TAGS[index],
        field: (
          <TokenAwareInput
            aria-label={`Radius ${cornerLabel(corner)}`}
            value={stored[index] || undefined}
            placeholder={fallback(corner)}
            tokens={tokens}
            tooltipOnOverflow
            onCommit={(resolved) => onChange(cornerKey(corner), resolved)}
            onStep={(delta) => {
              const next = stepCssLength(stored[index] || fallback(corner), delta)
              if (next) onChange(cornerKey(corner), next)
            }}
          />
        ),
      }))}
      onModeChange={(next) => {
        // Re-linking collapses the corners onto the first one's value so the
        // single field the user is about to type into is honest.
        if (next === 'all' && anySet && !uniform) writeAll(stored[0] || undefined)
        setScope(next)
      }}
    />
  )
}
