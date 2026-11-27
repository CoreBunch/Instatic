import type { ReactNode } from 'react'
import styles from '../AccountPage.module.css'

interface AccountRowProps {
  title: string
  status: string
  statusActive?: boolean
  editor?: ReactNode
  action?: ReactNode
  testId?: string
}

export function AccountRow({ title, status, statusActive, editor, action, testId }: AccountRowProps) {
  return (
    <div className={styles.accountRow} data-editing={editor ? true : undefined} data-testid={testId}>
      <h3 className={styles.rowTitle}>{title}</h3>
      {editor || (
        <>
          <span className={styles.rowValue} data-active={statusActive || undefined}>{status}</span>
          {action && <div className={styles.rowAction}>{action}</div>}
        </>
      )}
    </div>
  )
}
