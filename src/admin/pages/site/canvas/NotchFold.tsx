import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './NotchFold.module.css'

export function NotchFold({ compact, className, children }: { compact: boolean; className: string; children: ReactNode }) {
  return (
    <span className={styles.fold} data-notch-fold="" data-compact={compact} inert={compact} aria-hidden={compact || undefined}>
      <span className={styles.clip}>
        <span className={cn(styles.row, className)} data-notch-row="">{children}</span>
      </span>
    </span>
  )
}
