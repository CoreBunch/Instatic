/**
 * SeoFormRow — the SEO workspace's shared form row: a two-column grid with
 * a muted label (plus optional inline action) on the left and the control
 * stack on the right. Every form in the workspace — the Meta editor, the
 * image fields, the Robots/Sitemap tabs — renders rows through this one
 * component so they all read the same.
 *
 * SeoSwitchRow is the boolean variant: hint text left, Switch pinned right
 * in the control column.
 */
import type { ReactNode } from 'react'
import { Switch } from '@ui/components/Switch'
import styles from './SeoFormRow.module.css'

interface SeoFormRowProps {
  label: string
  /** Associates the label element with a control id. */
  htmlFor?: string
  /** Inline action rendered next to the label (e.g. the AI sparkle). */
  labelAction?: ReactNode
  /**
   * Anchor id + programmatic focus target (tabIndex -1) — used by the Meta
   * editor's improvements list for rows without a single focusable input.
   */
  anchorId?: string
  children: ReactNode
}

export function SeoFormRow({ label, htmlFor, labelAction, anchorId, children }: SeoFormRowProps) {
  return (
    <div id={anchorId} tabIndex={anchorId !== undefined ? -1 : undefined} className={styles.row}>
      <div className={styles.labelCell}>
        {htmlFor !== undefined ? (
          <label htmlFor={htmlFor} className={styles.label}>{label}</label>
        ) : (
          <span className={styles.label}>{label}</span>
        )}
        {labelAction}
      </div>
      {children}
    </div>
  )
}

interface SeoSwitchRowProps {
  id: string
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (value: boolean) => void
  'data-testid'?: string
}

export function SeoSwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
  'data-testid': testId,
}: SeoSwitchRowProps) {
  return (
    <SeoFormRow label={label} htmlFor={id}>
      <div className={styles.switchRow}>
        <span className={styles.hint}>{hint}</span>
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          aria-label={label}
          data-testid={testId}
        />
      </div>
    </SeoFormRow>
  )
}
