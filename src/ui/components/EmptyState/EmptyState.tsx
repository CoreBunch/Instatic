/**
 * EmptyState — shared placeholder for empty panels and empty sections.
 *
 * Replaces the duplicated `.emptyState` blocks that lived in every panel
 * (ColorsPanel, SelectorsPanel, FrameworkScalePanel, SiteExplorerPanel,
 * ContentExplorerPanel, AgentPanel, CodeEditorPanel, PropertiesPanel,
 * BreakpointFrame). One primitive, two visual variants:
 *
 *   - variant="card" (default) — surfaced rounded card with muted text.
 *     Used when the panel body has filters/headers but the list itself is
 *     empty. Pairs naturally with an `action` (e.g. "Create color" button).
 *
 *   - variant="centered" — stretches to fill its parent and centers the
 *     content. Used when the empty state replaces the entire panel body
 *     (e.g. "Select an element to view its properties", agent intro,
 *     empty canvas).
 *
 * Optional content slots (all renderable in either variant):
 *   - icon         — tiny pixel-art icon shown above the title
 *   - title        — primary line ("No colors yet.", "Empty page", etc.)
 *   - description  — secondary hint shown underneath
 *   - action       — CTA, almost always a Button primitive
 *   - children     — escape hatch for fully custom content
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles
 *   - Strictly achromatic tokens — colours via --editor-* vars
 *   - role="status" by default for assistive tech (overridable)
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  /**
   * Visual mode.
   *  - 'card'     (default) — surfaced rounded card; sits inline in a panel.
   *  - 'centered' — flex-fills its parent and centers content; used when the
   *                 empty state replaces the entire panel body.
   */
  variant?: 'card' | 'centered'
  /** Larger text + spacing for primary panel empty states. */
  size?: 'default' | 'large'
  /** Tighter padding — used for in-section / inline empties. */
  compact?: boolean
  /**
   * Drops the surface background. Useful when the empty state already sits
   * inside a card or Section that owns the chrome.
   */
  plain?: boolean
  /** Override the default text alignment. Card defaults to start, centered to center. */
  align?: 'start' | 'center'
  /** Optional pixel-art icon shown above the title. */
  icon?: ReactNode
  /** Primary line ("No colors yet.", "Empty page", etc.). */
  title?: ReactNode
  /** Secondary hint shown underneath the title. */
  description?: ReactNode
  /** Optional CTA — usually a Button primitive. */
  action?: ReactNode
  /** Escape hatch for fully custom content. */
  children?: ReactNode
  /** ARIA role. Defaults to 'status' for non-blocking announcements. */
  role?: string
  /** ARIA label. Optional override. */
  'aria-label'?: string
  /** Layout escape hatch (e.g. `grid-column: 1 / -1` when nested in a grid). */
  className?: string
  /** Test-id forwarded to the root element. */
  'data-testid'?: string
}

export function EmptyState({
  variant = 'card',
  size = 'default',
  compact = false,
  plain = false,
  align,
  icon,
  title,
  description,
  action,
  children,
  role = 'status',
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: EmptyStateProps) {
  const resolvedAlign = align ?? (variant === 'centered' ? 'center' : 'start')

  return (
    <div
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        styles.root,
        styles[`variant-${variant}`],
        size !== 'default' && styles[`size-${size}`],
        styles[`align-${resolvedAlign}`],
        compact && styles.compact,
        plain && styles.plain,
        className,
      )}
    >
      {icon ? <span className={styles.icon} aria-hidden="true">{icon}</span> : null}
      {title ? <p className={styles.title}>{title}</p> : null}
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <span className={styles.action}>{action}</span> : null}
      {children}
    </div>
  )
}
