/**
 * SizeSection — the inspector redesign's `size` editor.
 *
 *   Width  [ 801 ▲▼ ] [ Fixed ▾ ]
 *   Height [ 100% ▲▼ ] [ Fill  ▾ ]
 *
 * • DimensionRow — a fused pair: a token-aware value field with the shared
 *   hover-revealed ▲▼ stepper, plus a sizing-MODE select that rewrites the
 *   value:
 *       Fixed       → `<n>px`   (typed bare numbers get px)
 *       Relative    → `<n>%`
 *       Fill        → `100%`
 *       Fit Content → `fit-content`
 *       Viewport    → `100vh`   (height only)
 *   Any other CSS the user types (`calc(…)`, tokens) passes through
 *   untouched — the select then just reflects what it can detect.
 *
 * • Ratio lock — the bracket spanning both rows locks the width:height
 *   ratio: while locked, committing one dimension writes BOTH in one patch
 *   (one undo entry), scaled to preserve the ratio. Only offered while both
 *   dimensions hold numeric values in the same unit — `auto` / `fit-content`
 *   / mixed units have no ratio to keep.
 *
 * The constraint properties (min/max width/height) and the raw
 * aspect-ratio / box-sizing rows have no standing row: they are added from
 * the section header's "+" and render as ordinary rows once set.
 */

import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { Select } from '@ui/components/Select'
import { PadlockGlyph } from '@ui/icons/inspectorGlyphs'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { ClassPropertyRow } from './ClassPropertyRow'
import { hasStyleValue } from './styleValueUtils'
import styles from './SizeSection.module.css'

// ---------------------------------------------------------------------------
// Sizing modes
// ---------------------------------------------------------------------------

type SizeMode = 'fixed' | 'relative' | 'fill' | 'fit' | 'viewport'
type Dimension = 'width' | 'height'

const MODE_OPTIONS: ReadonlyArray<{ value: SizeMode; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'relative', label: 'Relative' },
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit Content' },
]

/* Height additionally offers Viewport (100vh) — per the redesign's height
   mode list; a viewport-height WIDTH is niche enough to type by hand. */
const HEIGHT_MODE_OPTIONS: ReadonlyArray<{ value: SizeMode; label: string }> = [
  ...MODE_OPTIONS,
  { value: 'viewport', label: 'Viewport' },
]

/** Values that mean "size to content" — CSS spellings of Figma's Fit. */
const FIT_VALUES = new Set(['auto', 'fit-content', 'min-content', 'max-content'])

function detectMode(value: unknown): SizeMode {
  if (!hasStyleValue(value)) return 'fixed'
  const v = String(value).trim().toLowerCase()
  if (FIT_VALUES.has(v)) return 'fit'
  if (/(d|s|l)?vh$/.test(v)) return 'viewport'
  if (v === '100%') return 'fill'
  if (v.endsWith('%')) return 'relative'
  return 'fixed'
}

const NUMERIC_RE = /^(-?\d*\.?\d+)\s*(px|%|rem|em|vw|vh|dvw|dvh|svw|svh|lvw|lvh|ch|ex)?$/i

function parseNumeric(value: unknown): { n: number; unit: string } | null {
  if (typeof value === 'number') return { n: value, unit: 'px' }
  if (typeof value !== 'string') return null
  const match = NUMERIC_RE.exec(value.trim())
  if (!match) return null
  return { n: Number.parseFloat(match[1]), unit: (match[2] ?? 'px').toLowerCase() }
}

/** Round scaled dimensions to at most 2 decimals so CSS stays readable. */
function roundValue(n: number): number {
  return Math.round(n * 100) / 100
}

/** Long-tail rows: no standing control, added from the section's "+". */
const ADDED_PROPERTIES: ReadonlyArray<keyof CSSPropertyBag> = [
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'aspectRatio',
  'boxSizing',
]

// ---------------------------------------------------------------------------
// SizeSection
// ---------------------------------------------------------------------------

interface SizeSectionProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  /** Active breakpoint tab id — the parent keys this component on it. */
  activeTab: string
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Applies several properties in one store commit (one undo entry). */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function SizeSection({
  currentStyles,
  storedStyles,
  activeTab,
  onChange,
  onChangeMany,
  onRemove,
  onPreview,
  onClearPreview,
}: SizeSectionProps) {
  // Ratio lock is transient editing state, not CSS — it doesn't persist.
  const [linked, setLinked] = useState(false)
  // Modes chosen while the dimension has no convertible value yet (e.g.
  // "Relative" picked on an unset width) — the next typed number honours it.
  const [modeOverride, setModeOverride] = useState<Partial<Record<Dimension, SizeMode>>>({})

  const spacingTokens = useSpacingTokens()

  const previewProperty = onPreview
    ? (property: keyof CSSPropertyBag, value: string | number | undefined) =>
        onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
    : undefined

  // The ratio lock needs both dimensions numeric in the same unit — there is
  // no ratio to preserve against `auto`, `fit-content`, or mixed units.
  const widthNumeric = parseNumeric(currentStyles.width)
  const heightNumeric = parseNumeric(currentStyles.height)
  const linkable =
    widthNumeric !== null &&
    heightNumeric !== null &&
    widthNumeric.n !== 0 &&
    heightNumeric.n !== 0 &&
    widthNumeric.unit === heightNumeric.unit

  function commitDimension(dimension: Dimension, raw: string | undefined) {
    setModeOverride((current) => ({ ...current, [dimension]: undefined }))
    if (raw === undefined || raw.trim() === '') {
      onRemove(dimension)
      return
    }
    let next = raw.trim()
    // Bare numbers get the unit the active mode implies; anything with an
    // explicit unit / token / function passes through untouched.
    if (/^-?\d*\.?\d+$/.test(next)) {
      const mode = modeOverride[dimension] ?? detectMode(currentStyles[dimension])
      next =
        mode === 'relative' || mode === 'fill'
          ? `${next}%`
          : mode === 'viewport'
            ? `${next}vh`
            : `${next}px`
    }

    if (linked && linkable) {
      const parsedNext = parseNumeric(next)
      const other: Dimension = dimension === 'width' ? 'height' : 'width'
      const selfCurrent = dimension === 'width' ? widthNumeric : heightNumeric
      const otherCurrent = dimension === 'width' ? heightNumeric : widthNumeric
      if (parsedNext && selfCurrent && otherCurrent && parsedNext.unit === selfCurrent.unit) {
        const scaled = roundValue((otherCurrent.n * parsedNext.n) / selfCurrent.n)
        onChangeMany({ [dimension]: next, [other]: `${scaled}${otherCurrent.unit}` })
        return
      }
    }
    onChange(dimension, next)
  }

  /** ▲▼ on a dimension field steps its numeric part, keeping the unit. */
  function stepDimension(dimension: Dimension, delta: number) {
    const parsed = parseNumeric(currentStyles[dimension])
    // `auto` / `fit-content` / `calc(…)` have no number to step.
    if (!parsed) return
    commitDimension(dimension, `${roundValue(parsed.n + delta)}${parsed.unit}`)
  }

  function applyMode(dimension: Dimension, mode: SizeMode) {
    const parsed = parseNumeric(currentStyles[dimension])
    if (mode === 'fill') {
      onChange(dimension, '100%')
    } else if (mode === 'fit') {
      onChange(dimension, 'fit-content')
    } else if (mode === 'viewport') {
      onChange(dimension, '100vh')
    } else if (parsed) {
      onChange(dimension, `${roundValue(parsed.n)}${mode === 'relative' ? '%' : 'px'}`)
    } else {
      // Nothing convertible (unset / fit-content) — clear the value and
      // remember the intent so the next typed number gets the right unit.
      if (hasStyleValue(storedStyles[dimension])) onRemove(dimension)
      setModeOverride((current) => ({ ...current, [dimension]: mode }))
    }
  }

  return (
    <>
      <div className={styles.sizeGroup}>
        {/* Ratio lock — the bracket spanning both rows IS the button. */}
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          className={styles.ratioLock}
          pressed={linked}
          aria-label={linked ? 'Unlink width and height' : 'Link width and height'}
          tooltip={
            linkable || linked
              ? linked
                ? 'Unlock aspect ratio'
                : 'Lock aspect ratio'
              : 'Ratio lock needs numeric width and height in the same unit'
          }
          disabled={!linkable && !linked}
          onClick={() => setLinked((current) => !current)}
        >
          <PadlockGlyph locked={linked} />
        </Button>
        <DimensionRow
          dimension="width"
          storedValue={storedStyles.width}
          currentValue={currentStyles.width}
          modeOverride={modeOverride.width}
          tokens={spacingTokens}
          onCommit={commitDimension}
          onStep={stepDimension}
          onModeChange={applyMode}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
        <DimensionRow
          dimension="height"
          storedValue={storedStyles.height}
          currentValue={currentStyles.height}
          modeOverride={modeOverride.height}
          tokens={spacingTokens}
          onCommit={commitDimension}
          onStep={stepDimension}
          onModeChange={applyMode}
          onPreview={previewProperty}
          onClearPreview={onClearPreview}
        />
      </div>

      {/* Constraints and raw shorthands appear only once SET — the section
          header's "+" is how they get added. */}
      {ADDED_PROPERTIES.filter((prop) => hasStyleValue(storedStyles[prop])).map((prop) => (
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
    </>
  )
}

// ---------------------------------------------------------------------------
// DimensionRow — label + fused (value field ⊕ sizing-mode select)
// ---------------------------------------------------------------------------

interface DimensionRowProps {
  dimension: Dimension
  storedValue: unknown
  currentValue: unknown
  /** Mode picked while the value was empty — overrides detection. */
  modeOverride: SizeMode | undefined
  tokens: ReturnType<typeof useSpacingTokens>
  onCommit: (dimension: Dimension, raw: string | undefined) => void
  onStep: (dimension: Dimension, delta: number) => void
  onModeChange: (dimension: Dimension, mode: SizeMode) => void
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

function DimensionRow({
  dimension,
  storedValue,
  currentValue,
  modeOverride,
  tokens,
  onCommit,
  onStep,
  onModeChange,
  onPreview,
  onClearPreview,
}: DimensionRowProps) {
  const isSet = hasStyleValue(storedValue)
  const label = dimension === 'width' ? 'Width' : 'Height'
  const rawMode = modeOverride ?? detectMode(isSet ? storedValue : currentValue)
  // Width has no Viewport option — a vh-valued width falls back to Fixed so
  // the select never holds a value outside its option list.
  const mode = dimension === 'width' && rawMode === 'viewport' ? 'fixed' : rawMode
  const placeholder = !isSet
    ? hasStyleValue(currentValue)
      ? String(currentValue)
      : 'auto'
    : undefined

  return (
    <ControlRow label={label} isSet={isSet}>
      <div className={styles.fused}>
        <TokenAwareInput
          aria-label={label}
          value={isSet ? String(storedValue) : undefined}
          placeholder={placeholder}
          tokens={tokens}
          onCommit={(resolved) => onCommit(dimension, resolved)}
          onStep={(delta) => onStep(dimension, delta)}
          onPreview={onPreview ? (resolved) => onPreview(dimension, resolved) : undefined}
          onClearPreview={onClearPreview}
        />
        <Select
          value={mode}
          fieldSize="sm"
          aria-label={`${label} sizing mode`}
          onChange={(event) => onModeChange(dimension, event.target.value as SizeMode)}
        >
          {(dimension === 'height' ? HEIGHT_MODE_OPTIONS : MODE_OPTIONS).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
    </ControlRow>
  )
}
