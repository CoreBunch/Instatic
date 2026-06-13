/**
 * FloatingActionBar — pill-shaped toolbar that floats at the bottom of
 * the viewport, anchoring contextual actions when a temporary mode is
 * active (e.g. "Customize" on the dashboard, "Bulk selection" on the
 * data grid).
 *
 * Layout
 * ------
 *   [ label ] | [ children — action buttons ] | [ optional close X ]
 *
 * Separators between the segments are auto-rendered only when both
 * sides exist, so the bar reads as one grouped control even when the
 * caller omits the label or the close button.
 *
 * Positioning
 * -----------
 * The bar uses `position: fixed` so it stays anchored to the bottom
 * of the viewport regardless of page scroll. Vertically offset 24px
 * from the bottom and horizontally centered.
 *
 * Conditional rendering
 * ---------------------
 * Pass `open={true}` to show, `open={false}` to hide. The bar plays a
 * brief slide-up + fade enter animation on mount and a reverse slide-
 * down + fade exit animation on `open` flipping to `false`. The DOM
 * stays mounted for the exit-animation duration (see `EXIT_DURATION_MS`)
 * via `useDelayedUnmount`. Once the animation finishes the component
 * unmounts cleanly. Honors `prefers-reduced-motion` via the matching
 * media query in `FloatingActionBar.module.css`.
 *
 * Accessibility
 * -------------
 *   - `role="toolbar"` + a required `ariaLabel` so screen readers
 *     announce the bar as an actions group.
 *   - The close button (when provided) gets an `aria-label` that
 *     defaults to "Close" but can be overridden via `closeLabel`.
 */
import type { ReactNode } from 'react'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { useDelayedUnmount } from '@ui/lib/useDelayedUnmount'
import styles from './FloatingActionBar.module.css'

/**
 * Must match the longest CSS animation duration in
 * `FloatingActionBar.module.css` (the `slideOut` keyframes). If you
 * bump the CSS timing, bump this too — the hook unmounts after this
 * many ms, so a smaller value here truncates the exit animation.
 */
const EXIT_DURATION_MS = 180

interface FloatingActionBarProps {
  /**
   * ARIA label for the `toolbar` landmark. Required — describes what
   * the bar's actions operate on (e.g. "Bulk row actions", "Customize
   * dashboard").
   */
  ariaLabel: string
  /**
   * Optional short message on the left side. A few words at most —
   * the bar isn't a banner. Pass `<strong>n</strong> selected` or
   * similar inline formatting via a ReactNode.
   */
  label?: ReactNode
  /**
   * Action buttons (Buttons, icon Buttons, anything inline-flex).
   * Rendered as a horizontal cluster between the label and the close
   * button.
   */
  children?: ReactNode
  /**
   * Optional close handler. When provided, an icon-only Button renders
   * on the right with the `closeLabel` aria-label. Omit when the bar's
   * own action buttons include a "Done" / "Cancel" that doubles as
   * dismissal.
   */
  onClose?: () => void
  /** ARIA label for the close button. Defaults to "Close". */
  closeLabel?: string
  /**
   * When `false`, returns `null` — handy for one-line conditional
   * rendering at the call site without an enclosing `&&` block.
   */
  open?: boolean
  /** Optional className passthrough for one-off layout adjustments. */
  className?: string
}

export function FloatingActionBar({
  ariaLabel,
  label,
  children,
  onClose,
  closeLabel = 'Close',
  open = true,
  className,
}: FloatingActionBarProps) {
  const { mounted, exiting } = useDelayedUnmount(open, EXIT_DURATION_MS)

  if (!mounted) return null

  const hasLabel = label !== undefined && label !== null && label !== false
  const hasChildren = children !== undefined && children !== null && children !== false
  const hasClose = typeof onClose === 'function'

  return (
    <div
      className={cn(styles.bar, exiting && styles.exiting, className)}
      role="toolbar"
      aria-label={ariaLabel}
    >
      {hasLabel && (
        <span className={styles.label}>{label}</span>
      )}
      {hasLabel && hasChildren && <span className={styles.sep} aria-hidden="true" />}
      {hasChildren && (
        <div className={styles.actions}>{children}</div>
      )}
      {(hasChildren || hasLabel) && hasClose && <span className={styles.sep} aria-hidden="true" />}
      {hasClose && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={closeLabel}
          tooltip={closeLabel}
          onClick={onClose}
        >
          <CloseIcon size={12} aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
