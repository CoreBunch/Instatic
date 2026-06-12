/**
 * FormField — shared labelled form-control shell for the editor UI.
 *
 * Wraps any control (Input, Textarea, Select, Switch, Checkbox, …) with a
 * label + optional description. Three layouts cover every common form
 * pattern in the admin and in plugin admin pages:
 *
 *   - `stacked` (default)
 *       label
 *       <control>
 *       description
 *
 *   - `inline-end`
 *       label              <control>
 *       description
 *     (used for toggle-style controls — Switch on the right.)
 *
 *   - `inline-start`
 *       <control>  label
 *                  description
 *     (used for checkbox-style controls — Checkbox on the left.)
 *
 * The whole field is wrapped in a `<label>` for the inline layouts so the
 * label text is clickable for activating the inner control. Stacked mode
 * uses a `<div>` because the inner control owns its own native `<label>`
 * association via `htmlFor`.
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles
 *   - All colours come from `--editor-*` design tokens
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './FormField.module.css'

type FormFieldLayout = 'stacked' | 'inline-end' | 'inline-start'

interface FormFieldProps {
  /** Visible label rendered next to (or above) the control. */
  label?: ReactNode
  /** Optional secondary hint shown underneath the label. */
  description?: ReactNode
  /**
   * Visual arrangement of label + description relative to the control.
   * Defaults to `'stacked'`.
   */
  layout?: FormFieldLayout
  /**
   * Associates the field's `<label>` with a specific control id when used
   * in `stacked` layout. Ignored for the inline layouts (the wrapping
   * `<label>` already captures clicks).
   */
  htmlFor?: string
  /** Layout escape hatch. */
  className?: string
  /** The control(s) rendered inside the field. */
  children: ReactNode
}

export function FormField({
  label,
  description,
  layout = 'stacked',
  htmlFor,
  className,
  children,
}: FormFieldProps) {
  if (layout === 'inline-end') {
    return (
      <label className={cn(styles.inlineEnd, className)}>
        <span className={styles.labelStack}>
          {label && <span className={styles.label}>{label}</span>}
          {description && (
            <span className={styles.description}>{description}</span>
          )}
        </span>
        {children}
      </label>
    )
  }

  if (layout === 'inline-start') {
    return (
      <label className={cn(styles.inlineStart, className)}>
        {children}
        <span className={styles.labelStack}>
          {label && <span className={styles.label}>{label}</span>}
          {description && (
            <span className={styles.description}>{description}</span>
          )}
        </span>
      </label>
    )
  }

  // Stacked — render as a plain div so the inner control's own native
  // label association (via `htmlFor` / `id`) stays canonical.
  if (!label && !description) return <>{children}</>
  return (
    <div className={cn(styles.stacked, className)}>
      {label && (
        <label className={styles.label} htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {description && <p className={styles.description}>{description}</p>}
    </div>
  )
}
