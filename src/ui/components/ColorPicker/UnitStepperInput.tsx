/** Numeric picker field with an editable draft and a unit suffix. */
import { useState } from 'react'
import { Input, InputStepper } from '@ui/components/Input'
import { clamp } from '@ui/lib/clamp'
import styles from './ColorPicker.module.css'

interface UnitStepperInputProps {
  /** Committed numeric value; the unit is appended for display. */
  value: number
  /** Unit glyph shown inside the value, e.g. `%` or `deg`. */
  unit: string
  min: number
  max: number
  ariaLabel: string
  /** Fires with the parsed, clamped value on Enter, blur, or a step. */
  onCommit: (next: number) => void
}

export function UnitStepperInput({
  value,
  unit,
  min,
  max,
  ariaLabel,
  onCommit,
}: UnitStepperInputProps) {
  const [draft, setDraft] = useState<string | null>(null)

  function commitDraft() {
    if (draft === null) return
    // `parseFloat` stops at the unit, so "180deg" and "180" both parse.
    const parsed = Number.parseFloat(draft)
    setDraft(null)
    if (Number.isFinite(parsed)) onCommit(clamp(Math.round(parsed), min, max))
  }

  function step(delta: number) {
    setDraft(null)
    const parsed = draft === null ? value : Number.parseFloat(draft)
    const base = Number.isFinite(parsed) ? parsed : value
    onCommit(clamp(Math.round(base) + delta, min, max))
  }

  return (
    <Input
      fieldSize="xs"
      spellCheck={false}
      value={draft ?? `${Math.round(value)}${unit}`}
      aria-label={ariaLabel}
      className={styles.unitInput}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commitDraft()
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          step(event.shiftKey ? 10 : 1)
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          step(event.shiftKey ? -10 : -1)
        }
      }}
      trailingSlot={<InputStepper label={ariaLabel} onStep={step} />}
    />
  )
}
