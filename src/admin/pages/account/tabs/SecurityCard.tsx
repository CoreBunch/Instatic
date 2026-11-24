import type { ReactNode } from 'react'
import layout from '@admin/shared/SettingsWorkspace/WorkspaceSection.module.css'
import { cn } from '@ui/cn'
import styles from '../AccountPage.module.css'

interface SecurityCardProps {
  title: string
  description: string
  status: string
  statusActive?: boolean
  action: ReactNode
  testId: string
}

export function SecurityCard({
  title,
  description,
  status,
  statusActive = false,
  action,
  testId,
}: SecurityCardProps) {
  return (
    <div className={cn(layout.detailCard, styles.card)} data-testid={testId}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>{title}</h2>
          <p className={styles.cardDesc}>{description}</p>
        </div>
        <div className={styles.cardActions}>{action}</div>
      </div>
      <p
        className={
          statusActive
            ? `${styles.cardStatus} ${styles.cardStatusActive}`
            : styles.cardStatus
        }
        role="status"
      >
        {status}
      </p>
    </div>
  )
}
