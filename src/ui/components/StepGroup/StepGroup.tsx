/**
 * StepGroup — the inspector redesign's − | + pair for countable values
 * (grid track counts, z-index, …). Two fused surface tiles on the shared
 * control height; the caller owns the value and clamping.
 *
 * This is deliberately NOT a spinner-in-field: the redesign's rule is
 * "StepGroup − / + when the value is countable; chevrons in the field for a
 * free dimension".
 */
import { Button } from '@ui/components/Button'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { cn } from '@ui/cn'
import styles from './StepGroup.module.css'

interface StepGroupProps {
  onStep: (delta: 1 | -1) => void
  /** What is being stepped — builds the aria labels ("Fewer columns"). */
  decreaseLabel: string
  increaseLabel: string
  disabled?: boolean
  className?: string
}

export function StepGroup({
  onStep,
  decreaseLabel,
  increaseLabel,
  disabled = false,
  className,
}: StepGroupProps) {
  return (
    <div role="group" className={cn(styles.group, className)}>
      <Button
        variant="secondary"
        size="sm"
        iconOnly
        aria-label={decreaseLabel}
        className={styles.seg}
        disabled={disabled}
        onClick={() => onStep(-1)}
      >
        <MinusIcon size={12} color="currentColor" />
      </Button>
      <Button
        variant="secondary"
        size="sm"
        iconOnly
        aria-label={increaseLabel}
        className={styles.seg}
        disabled={disabled}
        onClick={() => onStep(1)}
      >
        <PlusIcon size={12} color="currentColor" />
      </Button>
    </div>
  )
}
