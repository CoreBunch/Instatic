import type { ReactNode } from 'react'
import { SplitButton, type SplitButtonMenuItem } from '@ui/components/SplitButton'
import { Tooltip } from '@ui/components/Tooltip'
import type { IconComponent } from 'pixel-art-icons/types'
import styles from './Toolbar.module.css'

export type PublishActionStatusTone = 'neutral' | 'success' | 'warning' | 'danger'
type PublishActionState = 'idle' | 'busy' | 'success' | 'error'

export type PublishActionMenuItem = SplitButtonMenuItem

interface PublishActionGroupProps {
  statusLabel?: string | null
  statusTone?: PublishActionStatusTone
  statusAriaLabel?: string
  /**
   * Hover detail for the status text. The status is often the only enabled
   * thing in the group — a blocked publish disables the button — so it has to
   * carry the explanation too.
   */
  statusTooltip?: ReactNode
  publishLabel: string
  publishAriaLabel: string
  /** Rich node allowed: the runtime gate shows the actual diagnostics here. */
  publishTitle: ReactNode
  publishState?: PublishActionState
  publishDisabled?: boolean
  publishBusy?: boolean
  publishIcon: IconComponent
  onPublish: () => void | Promise<void>
  menuItems: PublishActionMenuItem[]
  menuLabel?: string
  triggerLabel?: string
}

export function PublishActionGroup({
  statusLabel,
  statusTone = 'neutral',
  statusAriaLabel,
  statusTooltip,
  publishLabel,
  publishAriaLabel,
  publishTitle,
  publishState = 'idle',
  publishDisabled = false,
  publishBusy = false,
  publishIcon,
  onPublish,
  menuItems,
  menuLabel = 'Publishing actions',
  triggerLabel = 'More publishing actions',
}: PublishActionGroupProps) {
  return (
    <div className={styles.publishActionGroup}>
      {statusLabel && (() => {
        const status = (
          <span
            role="status"
            aria-live="polite"
            aria-label={statusAriaLabel ?? statusLabel}
            className={styles.publishActionStatus}
            data-tone={statusTone}
            data-has-detail={statusTooltip ? 'true' : undefined}
          >
            <span className={styles.publishActionStatusDot} aria-hidden="true" />
            {statusLabel}
          </span>
        )
        return statusTooltip ? <Tooltip content={statusTooltip} size="wide">{status}</Tooltip> : status
      })()}

      <SplitButton
        variant={publishState === 'error' ? 'destructive' : 'primary'}
        size="sm"
        label={publishLabel}
        icon={publishIcon}
        onClick={onPublish}
        disabled={publishDisabled}
        busy={publishBusy}
        primaryAriaLabel={publishAriaLabel}
        primaryTooltip={publishTitle}
        primaryState={publishState}
        primaryClassName={styles.publishPrimaryButton}
        triggerClassName={styles.publishMenuTrigger}
        menuItems={menuItems}
        menuLabel={menuLabel}
        menuTriggerLabel={triggerLabel}
        primaryTestId="toolbar-publish-btn"
        menuTriggerTestId="toolbar-publish-actions-trigger"
        menuTestId="toolbar-publish-actions-menu"
      />
    </div>
  )
}
