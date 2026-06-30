import { cn } from '@ui/cn'
import { SplitButton, type SplitButtonMenuItem } from '@ui/components/SplitButton'
import type { IconComponent } from 'pixel-art-icons/types'
import styles from './Toolbar.module.css'

export type PublishActionStatusTone = 'neutral' | 'success' | 'warning' | 'danger'
type PublishActionState = 'idle' | 'busy' | 'success' | 'error'

export type PublishActionMenuItem = SplitButtonMenuItem

interface PublishActionGroupProps {
  statusLabel?: string | null
  statusTone?: PublishActionStatusTone
  statusAriaLabel?: string
  publishLabel: string
  publishAriaLabel: string
  publishTitle: string
  publishState?: PublishActionState
  publishDisabled?: boolean
  publishBusy?: boolean
  publishIcon: IconComponent
  onPublish: () => void | Promise<void>
  menuItems: PublishActionMenuItem[]
  menuLabel?: string
  triggerLabel?: string
  toast?: {
    tone: 'status' | 'alert'
    message: string
  } | null
}

export function PublishActionGroup({
  statusLabel,
  statusTone = 'neutral',
  statusAriaLabel,
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
  toast,
}: PublishActionGroupProps) {
  return (
    <div className={styles.publishActionGroup}>
      {statusLabel && (
        <span
          role="status"
          aria-live="polite"
          aria-label={statusAriaLabel ?? statusLabel}
          className={styles.publishActionStatus}
          data-tone={statusTone}
        >
          <span className={styles.publishActionStatusDot} aria-hidden="true" />
          {statusLabel}
        </span>
      )}

      <div className={styles.publishActionWrapper}>
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

        {toast && (
          <div
            role={toast.tone === 'alert' ? 'alert' : 'status'}
            className={cn(
              styles.publishToast,
              toast.tone === 'status' && styles.publishToastStatus,
            )}
          >
            {toast.message}
          </div>
        )}
      </div>
    </div>
  )
}
