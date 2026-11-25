import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Alert.module.css'

interface AlertProps {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  /** Use status for persistent warnings when inspecting an existing record. */
  role?: 'alert' | 'status'
  className?: string
  'data-testid'?: string
}

export function Alert({ tone = 'info', title, children, action, role, className, 'data-testid': testId }: AlertProps) {
  return (
    <div
      className={cn(styles.alert, className)}
      data-tone={tone}
      data-testid={testId}
      role={role ?? (tone === 'warning' || tone === 'danger' ? 'alert' : 'status')}
    >
      {title && <strong>{title}</strong>}
      {children != null && <div>{children}</div>}
      {action && <div>{action}</div>}
    </div>
  )
}
