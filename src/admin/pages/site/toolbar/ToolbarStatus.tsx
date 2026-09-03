/**
 * ToolbarStatus — the toolbar's small live-status indicator: a tone dot and
 * a short label ("Draft synced", "Draft changed", "Runtime error"). One
 * component so every workspace toolbar (Site, Content, Plugin IDE) shows
 * state the same way; the tone is the only thing that varies.
 */
import styles from './Toolbar.module.css'

export type ToolbarStatusTone = 'neutral' | 'success' | 'warning' | 'danger'

interface ToolbarStatusProps {
  label: string
  tone: ToolbarStatusTone
  /** Screen-reader text when the visible label is not enough on its own. */
  ariaLabel?: string
  testId?: string
  /** Extra hook for callers that key styles or tests off the state. */
  state?: string
}

export function ToolbarStatus({ label, tone, ariaLabel, testId, state }: ToolbarStatusProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={ariaLabel ?? label}
      className={styles.publishActionStatus}
      data-tone={tone}
      data-state={state}
      data-testid={testId}
    >
      <span className={styles.publishActionStatusDot} aria-hidden="true" />
      {label}
    </span>
  )
}
