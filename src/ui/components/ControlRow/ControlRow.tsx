/**
 * ControlRow — shared layout shell used by every property control row.
 *
 * Owns the wrapper div + label row so individual controls don't have to
 * duplicate the same boilerplate. Honors the `layout` variant:
 *
 *   - `inline` (default): 100px label column + control column.
 *   - `stacked`: label on its own line above a full-width control.
 *
 * The `labelSuffix` slot is used by controls that surface inline metadata
 * next to the label (e.g. NumberControl's unit, MediaLibraryControl /
 * UrlControl's validation error).
 *
 * Shared admin primitive — used by the site editor's PropertiesPanel
 * property controls and the data admin's TableSettings inspector.
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './ControlRow.module.css'

/** Row layout variant. Mirrors `PropertyControlLayout` from the module engine. */
type ControlRowLayout = 'inline' | 'stacked'

interface ControlRowProps {
  /** Property key — used for the `htmlFor`/`id` linkage when `inputId` is omitted. */
  propKey: string
  /** Visible label text. Falls back to `propKey` when omitted. */
  label?: string
  /** Override the input id used for the `htmlFor` attribute. */
  inputId?: string
  /** Render the row in inline (default) or stacked layout. */
  layout?: ControlRowLayout
  /** Narrow 52px label column — popout interiors (border/fill/shadow editors). */
  narrow?: boolean
  /** Highlight the label as a breakpoint override. */
  isOverride?: boolean
  /** Dim the row to indicate the control is disabled. */
  disabled?: boolean
  /** Optional inline content rendered after the label (unit, validation error). */
  labelSuffix?: ReactNode
  /** Optional caption shown below the row in subdued text. */
  description?: ReactNode
  /** The actual control input(s). */
  children: ReactNode
}

export function ControlRow({
  propKey,
  label,
  inputId,
  layout = 'inline',
  narrow,
  isOverride,
  disabled,
  labelSuffix,
  description,
  children,
}: ControlRowProps) {
  // Allow callers to fully suppress the label row by passing `label=""`
  // (empty string). Useful when a control is embedded inside another
  // labelled control (e.g. BackgroundImageControl mounting MediaLibraryControl
  // inside its `image` mode) and a second label would just add a dead row
  // beneath the outer label. Passing `undefined` keeps the legacy fallback
  // of using `propKey` as the visible label.
  const showLabelRow = label !== ''

  return (
    <div
      className={cn(
        styles.controlWrapper,
        layout === 'stacked' && styles.controlWrapperStacked,
        narrow && styles.controlWrapperNarrow,
        !showLabelRow && styles.controlWrapperNoLabel,
        disabled && styles.controlWrapperDisabled,
      )}
    >
      {showLabelRow && (
        <div className={styles.labelRow}>
          <label
            htmlFor={inputId ?? `ctrl-${propKey}`}
            className={isOverride ? styles.labelOverride : undefined}
          >
            {label ?? propKey}
          </label>
          {labelSuffix}
        </div>
      )}
      {children}
      {description && (
        <span className={styles.description}>{description}</span>
      )}
    </div>
  )
}
