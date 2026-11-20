import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { Button } from '@ui/components/Button'
import styles from './Input.module.css'

interface InputStepperProps {
  label: string
  hidden?: boolean
  onStep: (steps: number) => void
}

/** Trailing step controls for editable text values with units. */
export function InputStepper({ label, hidden, onStep }: InputStepperProps) {
  return (
    <span className={styles.stepper} hidden={hidden}>
      {([1, -1] as const).map((direction) => {
        const Chevron = direction === 1 ? ChevronUpIcon : ChevronDownIcon
        return (
          <Button
            key={direction}
            variant="ghost"
            size="micro"
            iconOnly
            tabIndex={-1}
            className={styles.stepButton}
            aria-label={`${direction === 1 ? 'Increase' : 'Decrease'} ${label}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => onStep(direction * (event.shiftKey ? 10 : 1))}
          >
            <Chevron size={9} aria-hidden="true" />
          </Button>
        )
      })}
    </span>
  )
}
