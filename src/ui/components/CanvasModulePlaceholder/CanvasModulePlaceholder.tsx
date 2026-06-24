/**
 * CanvasModulePlaceholder — shared empty-state primitive for module canvas
 * previews (base.image, base.video, base.outlet, base.loop,
 * base.slot-outlet, base.visual-component-ref, …).
 *
 * Why a dedicated primitive? Each module used to ship its own placeholder
 * (white box vs. dark navy box vs. dashed border, etc.) — inconsistent
 * across the canvas and several used forbidden hex colours. This primitive
 * gives every module the same neutral, achromatic affordance so authors
 * can instantly tell "this is a placeholder slot" no matter which module
 * they dropped.
 *
 * Visual contract:
 *   - Soft achromatic stripe pattern (subtle 45° diagonal lines) over a
 *     low-contrast surface tint. Visible on any canvas background, never
 *     loud enough to compete with real content above/below.
 *   - No border by default — the stripe pattern is the affordance.
 *   - Vertical icon + label + optional description stack for `variant='block'`
 *     (image, video, content, loop). Horizontal icon + label inline for
 *     `variant='inline'` (slot-outlet marker, missing VC ref hint).
 *
 * Constraints:
 *   - CSS Modules only (no Tailwind utility classes).
 *   - Strictly achromatic — colours via direct global design tokens tokens + color-mix.
 *   - Editor-only chrome — never imported from a module's `index.ts`
 *     render path; this primitive only renders inside `*Editor.tsx`.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './CanvasModulePlaceholder.module.css'

interface CanvasModulePlaceholderProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional pixel-art icon shown above (block) or before (inline) the label. */
  icon?: ReactNode
  /** Primary line — short message identifying what's missing. */
  label: ReactNode
  /** Visual arrangement for icon + label. Defaults to the stacked block empty state. */
  layout?: 'stack' | 'row'
  /** Secondary line — extra context (e.g. drop instructions). Block variant only. */
  description?: ReactNode
  /**
   * Optional action row rendered below the description on the `block`
   * variant — used by placeholders that need to offer a one-click affordance
   * (e.g. "Add dependency" for a plugin module whose declared package isn't
   * installed yet). The actions container has `data-canvas-interactive="true"`
   * so clicks bypass the canvas selection logic in `NodeWrapper`.
   */
  actions?: ReactNode
  /**
   * Forward the user's module class assignments so layout the author applied
   * (margin, padding, sizing, etc.) still takes effect even while the
   * module is empty. The canvas selection ring / inline edit hooks read
   * data attributes via `mcClassName` too.
   */
  className?: string
  /**
   * - 'block'  (default) — fills the module's allotted width with a minimum
   *   height so the layer is visible on canvas. Icon + label stack
   *   vertically and center.
   * - 'inline' — a thin label strip (one row, ~32 px tall). Used for
   *   placeholder markers like slot outlets or "unknown component" errors
   *   that shouldn't take up a full block of space.
   */
  variant?: 'block' | 'inline'
}

export function CanvasModulePlaceholder({
  icon,
  label,
  layout = 'stack',
  description,
  actions,
  className,
  variant = 'block',
  ...rootProps
}: CanvasModulePlaceholderProps) {
  return (
    <div
      {...rootProps}
      className={cn(styles.root, styles[`variant-${variant}`], className)}
      data-canvas-module-placeholder=""
      data-variant={variant}
      data-layout={layout}
    >
      <div className={styles.content} data-instatic-placeholder-content="">
        {icon ? (
          <span
            className={styles.icon}
            data-instatic-placeholder-icon=""
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
        <span className={styles.label} data-instatic-placeholder-label="">{label}</span>
        {variant === 'block' && description ? (
          <span className={styles.description} data-instatic-placeholder-description="">{description}</span>
        ) : null}
        {variant === 'block' && actions ? (
          // `data-canvas-interactive` opts the action row out of the canvas
          // selection capture in `NodeWrapper`, so clicks on the inner buttons
          // actually reach their `onClick` handlers instead of selecting the
          // node and stopping propagation.
          <div
            className={styles.actions}
            data-instatic-placeholder-actions=""
            data-canvas-interactive="true"
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}
