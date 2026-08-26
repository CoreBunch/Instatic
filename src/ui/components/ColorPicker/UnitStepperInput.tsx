/**
 * UnitStepperInput — the picker's numeric field with its unit INSIDE the
 * value ("100%", "180deg") and a bare stepper that only appears on hover.
 *
 * Deliberately not `<Input type="number">`: a number input cannot render the
 * unit as part of its value, and its spinner column is always visible and
 * heavy. Every numeric field in the picker uses this one component so opacity
 * and angle read identically — divergence there is what made the angle field
 * look like a different control.
 *
 * The draft buffer lives here: typing is free-form, and the value is parsed
 * and clamped only on Enter or blur, so a half-typed "18" never commits as an
 * angle of 18°.
 */

import { useState } from 'react'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { cn } from '@ui/cn'
import styles from './ColorPicker.module.css'

interface UnitStepperInputProps {
  /** Committed numeric value; the unit is appended for display. */
  value: number
  /** Unit glyph shown inside the value, e.g. `%` or `deg`. */
  unit: string
  min: number
  max: number
  ariaLabel: string
  className?: string
  /** Fires with the parsed, clamped value on Enter, blur, or a step. */
  onCommit: (next: number) => void
}

export function UnitStepperInput({
  value,
  unit,
  min,
  max,
  ariaLabel,
  className,
  onCommit,
}: UnitStepperInputProps) {
  const [draft, setDraft] = useState<string | null>(null)

  function clamp(next: number): number {
    return Math.min(max, Math.max(min, next))
  }

  function commitDraft() {
    if (draft === null) return
    // `parseFloat` stops at the unit, so "180deg" and "180" both parse.
    const parsed = Number.parseFloat(draft)
    setDraft(null)
    if (Number.isFinite(parsed)) onCommit(clamp(Math.round(parsed)))
  }

  function step(delta: number) {
    setDraft(null)
    onCommit(clamp(Math.round(value) + delta))
  }

  return (
    <Input
      fieldSize="xs"
      spellCheck={false}
      value={draft ?? `${Math.round(value)}${unit}`}
      aria-label={ariaLabel}
      className={cn(styles.unitInput, className)}
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
      trailingSlot={
        <span className={styles.unitStepper}>
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            tabIndex={-1}
            aria-label={`Increase ${ariaLabel}`}
            onClick={() => step(1)}
          >
            <ChevronUpIcon size={8} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="micro"
            iconOnly
            tabIndex={-1}
            aria-label={`Decrease ${ariaLabel}`}
            onClick={() => step(-1)}
          >
            <ChevronDownIcon size={8} aria-hidden="true" />
          </Button>
        </span>
      }
    />
  )
}
