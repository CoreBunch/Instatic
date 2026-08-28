/**
 * PositionSection — visual editor for the `position` CSS section.
 *
 * Three rows, exactly as the redesign prototype draws them:
 *
 *   Type    [ Relative              ▾ ]
 *   Inset   [ T auto ] [ R auto ]
 *           [ B auto ] [ L auto ]
 *   Z Index [ 10 ] [ − | + ]
 *
 *   • Type    — a plain full-width select. The prototype uses `.field select`
 *               here (not the `.buttongroup` the Layout section's Type row
 *               gets), so every position keyword sits in one list. The
 *               leading "Default" entry clears the property.
 *   • Inset   — the prototype's inset box: the Spacing widget's bands with a
 *               pinbox in the middle (see InsetBoxControl)
 *               inside the control column, each with its T / R / B / L tag at
 *               the field's leading edge. Revealed only when the position
 *               value actually honours offsets (relative / absolute / fixed /
 *               sticky — i.e. not static, not unset).
 *   • Z Index — number field + StepGroup − | + (a countable value, per the
 *               redesign's stepping rule). Stays visible even when position
 *               is unset/static: stacking context can matter on flex and grid
 *               items too.
 *
 * Row chrome comes from LayoutSection.module.css so the two sections share
 * one visual vocabulary.
 */

import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { StepGroup } from '@ui/components/StepGroup'
import { LabeledControl } from './LayoutSection/LabeledControl'
import { getCSSPropertyDefaultValue } from './cssControlTypes'
import { hasStyleValue, readString } from './styleValueUtils'
import { InsetBoxControl } from './SpacingBoxControl/InsetBoxControl'
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
   * Forwarded to the offset token inputs so hovering a suggestion previews on
   * the canvas.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

/** Position values that honor top/right/bottom/left and reveal the Inset row.
 *  `static` is intentionally excluded because static elements ignore those
 *  offsets. */
const POSITIONED_VALUES = new Set(['relative', 'absolute', 'fixed', 'sticky'])

const POSITION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'static', label: 'Static' },
  { value: 'relative', label: 'Relative' },
  { value: 'absolute', label: 'Absolute' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'sticky', label: 'Sticky' },
]

/** The four offsets the Inset box edits — read here only for the set-dot. */
const INSET_SIDES = ['top', 'right', 'bottom', 'left'] as const

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
  const position = readString(currentStyles, 'position')
  const positionIsActive = position != null && POSITIONED_VALUES.has(position)

  const zIndexStored = storedStyles.zIndex
  const zIndexIsSet = hasStyleValue(zIndexStored)
  const zIndexCurrent = currentStyles.zIndex
  const zIndexFallback = hasStyleValue(zIndexCurrent)
    ? zIndexCurrent
    : getCSSPropertyDefaultValue('zIndex')

  const insetIsSet = INSET_SIDES.some((property) => hasStyleValue(storedStyles[property]))

  return (
    <>
      <div data-testid="css-position-switcher" data-position-value={position ?? ''}>
        <LabeledControl label="Type" isSet={hasStyleValue(storedStyles.position)}>
          <Select
            fieldSize="sm"
            aria-label="Position"
            value={position ?? ''}
            onChange={(event) => {
              const next = event.target.value
              if (next === '') onClearProperty('position')
              else onChange('position', next)
            }}
          >
            <option value="">Default</option>
            {POSITION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </LabeledControl>
      </div>
      {positionIsActive && (
        <LabeledControl label="Inset" isSet={insetIsSet}>
          <InsetBoxControl
            storedStyles={storedStyles}
            currentStyles={currentStyles}
            onChange={onChange}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        </LabeledControl>
      )}
      <ZIndexRow
        key={`${activeTab}-zIndex`}
        isSet={zIndexIsSet}
        storedValue={zIndexStored}
        fallback={zIndexFallback}
        onChange={onChange}
        onRemove={onRemove}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// ZIndexRow — number field + StepGroup
// ---------------------------------------------------------------------------

interface ZIndexRowProps {
  isSet: boolean
  storedValue: unknown
  fallback: unknown
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
}

/** Digits with an optional leading minus — the only draft a z-index accepts. */
const Z_INDEX_DRAFT_RE = /^-?\d*$/

function ZIndexRow({ isSet, storedValue, fallback, onChange, onRemove }: ZIndexRowProps) {
  // Lexical drafts (`-`, empty) survive while typing; finite values persist
  // live as numbers — same contract as the generic number-typed rows.
  const [draft, setDraft] = useState<string | null>(null)
  // Imported documents (HTML `style=""`, imported stylesheets) store z-index
  // as the string CSS gave them — read both shapes; edits re-store a number.
  const storedNumber = toFiniteNumber(storedValue)

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (isSet) onRemove('zIndex')
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) onChange('zIndex', Math.trunc(parsed))
  }

  return (
    <div data-testid="css-property-row-zIndex" data-state={isSet ? 'set' : 'unset'}>
      <LabeledControl label="Z Index" isSet={isSet}>
        <div className={styles.trackDuo}>
          <Input
            aria-label="Z index"
            fieldSize="sm"
            inputMode="numeric"
            value={draft ?? (storedNumber !== null ? String(storedNumber) : '')}
            placeholder={!isSet ? String(fallback) : undefined}
            onFocus={() => setDraft(storedNumber !== null ? String(storedNumber) : '')}
            onChange={(event) => {
              // Numeric field: anything but an integer draft is refused, so
              // stray letters never appear in the value.
              if (!Z_INDEX_DRAFT_RE.test(event.target.value.trim())) return
              setDraft(event.target.value)
              commit(event.target.value)
            }}
            onBlur={(event) => {
              commit(event.target.value)
              setDraft(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            }}
          />
          <StepGroup
            decreaseLabel="Lower z-index"
            increaseLabel="Raise z-index"
            onStep={(delta) => onChange('zIndex', (storedNumber ?? 0) + delta)}
          />
        </div>
      </LabeledControl>
    </div>
  )
}

/** Accept a number or a numeric string ("7") — anything else is null. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

