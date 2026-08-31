/**
 * ControlRow — shared layout shell used by every property control row.
 *
 * Owns the wrapper div + label row so individual controls don't have to
 * duplicate the same boilerplate. Honors the `layout` variant:
 *
 *   - `inline` (default): 100px label column + control column.
 *   - `stacked`: label on its own line above a full-width control.
 *   - `wide`: the control keeps a usable width by WRAPPING under the label
 *     in a narrow dock instead of being squeezed beside it (spacing box,
 *     inset box — the prototype's `.row:has(> .spacebox)` behaviour).
 *
 * The inspector's "is this property set?" cue is the `isSet` prop: a 5px
 * accent dot in front of the label — never a colour change. The label keeps
 * one tone (`--text-muted`) whatever the state (prototype `.row > .label`).
 * `isSet` also stamps `data-state="set" | "unset"` on the wrapper.
 *
 * The `labelSuffix` slot is used by controls that surface inline metadata
 * next to the label (e.g. NumberControl's unit, MediaLibraryControl /
 * UrlControl's validation error).
 *
 * Shared admin primitive — used by the site editor's PropertiesPanel
 * (module property controls AND the visual style sections) and the data
 * admin's TableSettings inspector. Composite rows that own their whole grid
 * (ScopeGroup) reuse just the label anatomy via `ControlRowLabel`.
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './ControlRow.module.css'

/** Row layout variant. Mirrors `PropertyControlLayout` from the module engine. */
type ControlRowLayout = 'inline' | 'stacked'

interface ControlRowProps {
  /** Property key — used for the `htmlFor`/`id` linkage when `inputId` is omitted. */
  propKey?: string
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
  /**
   * Set-state cue: renders the accent dot before the label when true and
   * stamps `data-state` on the wrapper. Leave undefined for rows without a
   * set/unset notion (module props).
   */
  isSet?: boolean
  /** Wide-control row — the control wraps UNDER the label in a narrow dock. */
  wide?: boolean
  /** `data-testid` for the wrapper. */
  testId?: string
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
  isSet,
  wide,
  testId,
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
  // Rows without a form-control linkage (visual section rows whose inner
  // control carries its own aria-label) render a <span>, not a dangling
  // <label htmlFor> pointing at nothing.
  const htmlFor = inputId ?? (propKey !== undefined ? `ctrl-${propKey}` : undefined)
  const labelClass = cn(styles.label, isOverride && styles.labelOverride)
  const labelContent = (
    <>
      {isSet && <span className={styles.setDot} aria-hidden="true" />}
      {label ?? propKey}
    </>
  )

  return (
    <div
      className={cn(
        styles.controlWrapper,
        layout === 'stacked' && styles.controlWrapperStacked,
        narrow && styles.controlWrapperNarrow,
        wide && styles.controlWrapperWide,
        !showLabelRow && styles.controlWrapperNoLabel,
        disabled && styles.controlWrapperDisabled,
      )}
      data-state={isSet === undefined ? undefined : isSet ? 'set' : 'unset'}
      data-testid={testId}
    >
      {showLabelRow && (
        <div className={styles.labelRow}>
          {htmlFor !== undefined ? (
            <label htmlFor={htmlFor} className={labelClass}>
              {labelContent}
            </label>
          ) : (
            <span className={labelClass}>{labelContent}</span>
          )}
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

/**
 * ControlRowLabel — just the label anatomy (one tone, accent dot when set),
 * for composite rows that own their whole grid themselves and take the label
 * as a slot (ScopeGroup's Padding / Radius rows).
 */
export function ControlRowLabel({ label, isSet }: { label: string; isSet?: boolean }) {
  return (
    <span className={cn(styles.label, styles.standaloneLabel)}>
      {isSet && <span className={styles.setDot} aria-hidden="true" />}
      {label}
    </span>
  )
}
