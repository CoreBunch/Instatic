/**
 * UnitField — a CSS length as TWO controls: a numeric value field and a unit
 * select (px / % / em / …), with the property's keywords (`auto`, `none`,
 * `normal`) living in the same select.
 *
 * The author's reference panel draws every length this way ("Size [68][Px]")
 * instead of one free-text field, so a value can never be half-typed prose:
 * the field refuses anything that is not a number, and the unit is a pick,
 * not a suffix to remember.
 *
 * Behaviour:
 *   - Typing a finite number commits live as `${n}${unit}` (canvas follows
 *     each keystroke, same contract as the other numeric rows). Partial
 *     drafts (`-`, `1.`) stay local until they become finite.
 *   - Clearing the field commits `undefined` on blur — the property is
 *     removed, exactly like emptying any other row.
 *   - Picking a keyword stores the keyword and quiets the number field;
 *     picking a unit converts back, reusing the last visible number (or the
 *     placeholder's) so the value never jumps to something surprising.
 *   - A stored value the field cannot parse (`calc(…)`, `var(--x)`) is shown
 *     verbatim and left alone until the user types over it — the field
 *     guards INPUT, it never mangles imported values on read.
 *   - Steps (chevrons / scrub / ↑↓ via the Input primitive) move the number
 *     and keep the unit.
 */

import { useState } from 'react'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import styles from './UnitField.module.css'

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

type ParsedLength =
  | { kind: 'number'; number: string; unit: string }
  | { kind: 'keyword'; keyword: string }
  | { kind: 'raw'; raw: string }
  | { kind: 'empty' }

function parseLength(
  raw: string | undefined,
  units: ReadonlyArray<string>,
  keywords: ReadonlyArray<string>,
): ParsedLength {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { kind: 'empty' }
  const lower = trimmed.toLowerCase()
  if (keywords.includes(lower)) return { kind: 'keyword', keyword: lower }
  const match = trimmed.match(/^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i)
  if (match) {
    const unit = match[2].toLowerCase()
    // A bare `0` is unitless in CSS — adopt the field's first unit for display.
    if (unit === '') return { kind: 'number', number: match[1], unit: units[0] }
    if (units.includes(unit)) return { kind: 'number', number: match[1], unit }
  }
  return { kind: 'raw', raw: trimmed }
}

/** Digits with optional sign and decimal point — the only draft accepted. */
const NUMBER_DRAFT_RE = /^-?\d*\.?\d*$/

// ---------------------------------------------------------------------------
// UnitField
// ---------------------------------------------------------------------------

interface UnitFieldProps {
  id?: string
  /** Raw stored CSS value (`120px`, `50%`, `auto`, `calc(…)`, undefined). */
  value: string | undefined
  /** Raw CSS placeholder shown while unset (its unit seeds the select). */
  placeholder?: string
  /** Units offered by the select, in order; the first is the default. */
  units: ReadonlyArray<string>
  /** Keyword values (`auto`, `none`) listed after the units. */
  keywords: ReadonlyArray<string>
  'aria-label': string
  /** `undefined` removes the property (empty field committed). */
  onCommit: (raw: string | undefined) => void
}

export function UnitField({
  id,
  value,
  placeholder,
  units,
  keywords,
  'aria-label': ariaLabel,
  onCommit,
}: UnitFieldProps) {
  const parsed = parseLength(value, units, keywords)
  const parsedPlaceholder = parseLength(placeholder, units, keywords)

  // Lexical draft while typing (`-`, `1.`); null = mirror the stored value.
  const [draft, setDraft] = useState<string | null>(null)
  // Unit picked while the field is empty — remembered until a number arrives.
  const [pendingUnit, setPendingUnit] = useState<string | null>(null)

  const activeUnit =
    pendingUnit ??
    (parsed.kind === 'number'
      ? parsed.unit
      : parsed.kind === 'keyword'
        ? parsed.keyword
        : parsedPlaceholder.kind === 'number'
          ? parsedPlaceholder.unit
          : parsedPlaceholder.kind === 'keyword'
            ? parsedPlaceholder.keyword
            : units[0])
  const isKeyword = keywords.includes(activeUnit)

  const storedNumber =
    parsed.kind === 'number' ? parsed.number : parsed.kind === 'raw' ? parsed.raw : ''
  const shownNumber = draft ?? storedNumber
  const placeholderNumber =
    parsedPlaceholder.kind === 'number' ? parsedPlaceholder.number : undefined

  const commitNumber = (nextNumber: string, unitOverride?: string) => {
    const parsed = Number(nextNumber.trim())
    if (nextNumber.trim() === '' || !Number.isFinite(parsed)) return
    const unit = unitOverride ?? (isKeyword ? units[0] : activeUnit)
    // `Number` also normalises the draft: "050" → 50, ".5" → 0.5.
    onCommit(`${parsed}${unit}`)
  }

  const handleUnitChange = (next: string) => {
    if (keywords.includes(next)) {
      setPendingUnit(null)
      setDraft(null)
      onCommit(next)
      return
    }
    // A real unit: convert the number we're showing, or wait for one.
    const number =
      draft !== null && draft.trim() !== '' && Number.isFinite(Number(draft))
        ? draft.trim()
        : parsed.kind === 'number'
          ? parsed.number
          : (placeholderNumber ?? '')
    if (number !== '' && Number.isFinite(Number(number))) {
      setPendingUnit(null)
      onCommit(`${Number(number)}${next}`)
    } else {
      setPendingUnit(next)
    }
  }

  return (
    <div className={styles.duo}>
      <Input
        id={id}
        fieldSize="sm"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={isKeyword ? '' : shownNumber}
        placeholder={isKeyword ? activeUnit : placeholderNumber}
        disabled={isKeyword}
        onStep={
          isKeyword
            ? undefined
            : (delta) => {
                const base = Number(shownNumber !== '' ? shownNumber : (placeholderNumber ?? '0'))
                if (!Number.isFinite(base)) return
                const next = Math.round((base + delta) * 100) / 100
                if (draft !== null) setDraft(String(next))
                commitNumber(String(next))
              }
        }
        onFocus={() => setDraft(shownNumber)}
        onChange={(event) => {
          const next = event.target.value
          // A stored `calc(…)` shows verbatim; the first edit replaces it, and
          // from then on only numeric drafts get through.
          if (!NUMBER_DRAFT_RE.test(next.trim())) return
          setDraft(next)
          commitNumber(next)
        }}
        onBlur={(event) => {
          const trimmed = event.target.value.trim()
          if (trimmed === '' && parsed.kind !== 'empty' && !isKeyword) onCommit(undefined)
          else commitNumber(trimmed)
          setDraft(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        }}
      />
      <Select
        fieldSize="sm"
        aria-label={`${ariaLabel} unit`}
        value={activeUnit}
        onChange={(event) => handleUnitChange(event.target.value)}
      >
        {units.map((unit) => (
          <option key={unit} value={unit}>
            {unit}
          </option>
        ))}
        {keywords.map((keyword) => (
          <option key={keyword} value={keyword}>
            {keyword.charAt(0).toUpperCase() + keyword.slice(1)}
          </option>
        ))}
      </Select>
    </div>
  )
}
