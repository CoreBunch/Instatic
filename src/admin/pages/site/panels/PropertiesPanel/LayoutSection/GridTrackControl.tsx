/**
 * GridTrackControl — column / row count for `grid-template-*` as the
 * inspector redesign's "field + StepGroup − | +" row.
 *
 * The field accepts either a bare count (`3` → `repeat(3, 1fr)`) or any raw
 * track template (`200px 1fr`, `subgrid`, …) which passes through untouched.
 * The − | + tiles step the count when the current value IS a plain
 * `repeat(N, 1fr)` (or unset — stepping up from unset starts at 1); a custom
 * template has no count to step, so the tiles disable themselves.
 */

import { useState } from 'react'
import { Input } from '@ui/components/Input'
import { StepGroup } from '@ui/components/StepGroup'
import { ControlRow } from '@ui/components/ControlRow'
import styles from '../LayoutSection.module.css'

interface GridTrackControlProps {
  label: string
  ariaLabel: string
  value: string | undefined
  isSet: boolean
  onChange: (value: string) => void
  onClear: () => void
}

export function GridTrackControl({
  label,
  ariaLabel,
  value,
  isSet,
  onChange,
  onClear,
}: GridTrackControlProps) {
  const count = parseGridRepeat(value)
  const isCustom = value != null && value !== '' && count == null

  // The field shows the COUNT for repeat templates, the raw template
  // otherwise. A focused draft keeps what the user is typing.
  const shown = count != null ? String(count) : (value ?? '')
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      if (isSet) onClear()
      return
    }
    if (/^\d+$/.test(trimmed)) {
      const n = Math.min(99, Math.max(1, parseInt(trimmed, 10)))
      onChange(`repeat(${n}, 1fr)`)
      return
    }
    if (trimmed !== value) onChange(trimmed)
  }

  const step = (delta: number) => {
    // Unset steps up from zero; `repeat(N, 1fr)` steps N. Custom templates
    // have no count — the tiles disable and the field steppers no-op.
    if (isCustom) return
    const current = count ?? 0
    const next = Math.min(99, Math.max(1, current + delta))
    if (next === current) return
    if (draft !== null) setDraft(String(next))
    onChange(`repeat(${next}, 1fr)`)
  }

  return (
    <ControlRow label={label} isSet={isSet}>
      <div className={styles.trackDuo}>
        <Input
          fieldSize="sm"
          aria-label={ariaLabel}
          placeholder="auto"
          // The value is a COUNT (numeric keypad, ↑↓ / scrub via onStep); a
          // raw track template typed into the same field still passes through.
          inputMode="numeric"
          onStep={step}
          value={draft ?? shown}
          onFocus={() => setDraft(shown)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            commit(e.target.value)
            setDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <StepGroup
          decreaseLabel={`Fewer ${label.toLowerCase()}`}
          increaseLabel={`More ${label.toLowerCase()}`}
          disabled={isCustom}
          onStep={step}
        />
      </div>
    </ControlRow>
  )
}

/**
 * Parse a `repeat(N, 1fr)` template into its track count `N`. Returns null
 * for any other shape (custom templates, named tracks, mixed sizing,
 * subgrid, etc.). Whitespace tolerant — `repeat( 3 , 1fr )` still parses.
 */
function parseGridRepeat(value: string | undefined): number | null {
  if (!value) return null
  const m = value.trim().match(/^repeat\(\s*(\d+)\s*,\s*1fr\s*\)$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 && n <= 99 ? n : null
}
