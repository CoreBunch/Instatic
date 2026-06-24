/**
 * Alert — shared inline message primitive for the editor UI.
 *
 * One bordered panel-surface box with a tone-coloured border (`info`,
 * `success`, `warning`, `danger`). Used by plugin admin apps and any host
 * surface that needs to surface a non-blocking message inline.
 *
 * ARIA: `tone="danger"` / `tone="warning"` render with `role="alert"`
 * (assertive); `info` / `success` use `role="status"` (polite).
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles
 *   - Border colours come from semantic `direct global design tokens` tokens; background
 *     comes from `--bg-surface`
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Alert.module.css'

type AlertTone = 'info' | 'success' | 'warning' | 'danger'

interface AlertProps {
  /** Visual tone. Defaults to `'info'`. */
  tone?: AlertTone
  /** Optional bold title rendered above the body. */
  title?: ReactNode
  /** Optional className for layout escape hatches. */
  className?: string
  children?: ReactNode
}

const toneClass: Record<AlertTone, string> = {
  info: 'alertInfo',
  success: 'alertSuccess',
  warning: 'alertWarning',
  danger: 'alertDanger',
}

export function Alert({
  tone = 'info',
  title,
  className,
  children,
}: AlertProps) {
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status'
  return (
    <div
      className={cn(styles.alert, styles[toneClass[tone]], className)}
      role={role}
    >
      {title ? <strong className={styles.alertTitle}>{title}</strong> : null}
      <div className={styles.alertBody}>{children}</div>
    </div>
  )
}
