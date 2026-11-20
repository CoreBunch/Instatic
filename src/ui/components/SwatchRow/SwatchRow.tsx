import type { CSSProperties, Ref } from 'react'
import { Button } from '@ui/components/Button'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './SwatchRow.module.css'

interface SwatchRowProps {
  chipStyle: CSSProperties
  name: string
  isSet: boolean
  onClick: () => void
  ariaLabel: string
  ariaExpanded: boolean
  onClear?: () => void
  clearLabel: string
  triggerRef: Ref<HTMLButtonElement>
}

/** A fill or border preview opens its editor. Clearing it is a separate action. */
export function SwatchRow({
  chipStyle,
  name,
  isSet,
  onClick,
  triggerRef,
  ariaLabel,
  ariaExpanded,
  onClear,
  clearLabel,
}: SwatchRowProps) {
  return (
    <div className={styles.swatchRow}>
      <Button
        ref={triggerRef}
        variant="ghost"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={ariaExpanded}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        <span className={styles.chip} data-state={isSet ? 'set' : 'unset'} style={chipStyle} aria-hidden="true">
          {!isSet && <PlusIcon size={12} />}
        </span>
        <span className={styles.name} data-placeholder={isSet ? undefined : 'true'}>
          {name}
        </span>
      </Button>
      {onClear && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          className={styles.clear}
          aria-label={clearLabel}
          tooltip={clearLabel}
          onClick={onClear}
        >
          <CloseIcon size={12} />
        </Button>
      )}
    </div>
  )
}
