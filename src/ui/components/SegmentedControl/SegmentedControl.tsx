/**
 * SegmentedControl — connected button group for picking one value from a fixed set.
 *
 * Renders a row of pressable Buttons (fused via a 2px-padded track) where
 * exactly one segment is active when it matches `value`. When `value` is
 * `undefined` no segment appears active — useful for layout pickers where
 * "nothing chosen" is a meaningful state that hides downstream fields.
 *
 * Composes the shared Button primitive (`variant="secondary"`) so it inherits
 * achromatic tokens, focus rings, hover/active states, and tooltip support.
 *
 * Trailing slot:
 *   `trailing` is an optional render-prop receiving:
 *     - `segmentClassName` for buttons that should stretch like a primary
 *       segment (rare).
 *     - `trailingClassName` for icon-only fixed-width buttons (the typical
 *       case — e.g. a chevron-down dropdown trigger). This class keeps the
 *       button square (1:1) and prevents it from absorbing flex slack.
 *
 * Clear-on-active-click:
 *   When `onClear` is provided, clicking the currently-active segment fires
 *   `onClear()` instead of being a no-op. The CSS surface also gains a hover
 *   close-icon overlay on active segments so users can see *why* clicking a
 *   pressed segment now does something. Off by default — passive segmented
 *   controls (e.g. a single-choice tab strip) keep the standard "click active
 *   = no-op" semantics.
 */
import type { ReactNode } from 'react'
import { Button, type ButtonProps } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import styles from './SegmentedControl.module.css'

interface SegmentedControlOption<T extends string> {
  value: T
  label?: ReactNode
  icon?: ReactNode
  ariaLabel?: string
  tooltip?: ReactNode
}

interface SegmentedControlProps<T extends string> {
  /**
   * The currently active value, or `undefined` for an unset state where no
   * segment appears pressed.
   */
  value: T | undefined
  options: ReadonlyArray<SegmentedControlOption<T>>
  onChange: (next: T) => void
  /**
   * When provided, clicking the active segment fires this callback (instead
   * of being a no-op). Hovering the active segment shows a close-icon
   * overlay so users discover the clear affordance.
   */
  onClear?: () => void
  size?: ButtonProps['size']
  /** Darker active fill for tab strips embedded in black editor panel chrome. */
  activeSurface?: 'recessed'
  /** Render-prop for an extra trailing segment (e.g. dropdown chevron). */
  trailing?: (args: { segmentClassName: string; trailingClassName: string }) => ReactNode
  className?: string
  fullWidth?: boolean
  disabled?: boolean
  /** Aria-label for the surrounding role="group" wrapper. */
  'aria-label'?: string
  'data-testid'?: string
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  onClear,
  size = 'sm',
  activeSurface,
  trailing,
  className,
  fullWidth = false,
  disabled = false,
  'aria-label': ariaLabel,
  'data-testid': dataTestId,
}: SegmentedControlProps<T>) {
  const clearable = onClear != null

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={dataTestId}
      data-active-surface={activeSurface}
      data-clearable={clearable ? 'true' : undefined}
      className={cn(styles.group, fullWidth && styles.fullWidth, className)}
    >
      {options.map((option) => {
        const isActive = value === option.value
        const iconOnly = option.icon != null && option.label == null
        const label = option.ariaLabel ?? (typeof option.label === 'string' ? option.label : option.value)
        return (
          <Button
            key={option.value}
            variant="secondary"
            size={size}
            iconOnly={iconOnly}
            pressed={isActive}
            tooltip={isActive && clearable ? `Clear ${label}` : option.tooltip}
            aria-label={label}
            className={styles.segment}
            disabled={disabled}
            onClick={() => {
              if (isActive) {
                if (clearable) onClear?.()
                return
              }
              onChange(option.value)
            }}
          >
            {option.icon}
            {option.label}
            {/* Hover close overlay — only rendered (and only visible via CSS)
                when the parent is `data-clearable="true"` and this segment is
                pressed. Pure visual hint; the actual clear handler runs on the
                segment's own onClick above. */}
            {clearable && isActive && (
              <span aria-hidden="true" className={styles.clearOverlay}>
                <CloseIcon size={14} color="currentColor" />
              </span>
            )}
          </Button>
        )
      })}
      {trailing?.({
        segmentClassName: styles.segment,
        trailingClassName: cn(styles.segment, styles.trailing),
      })}
    </div>
  )
}
