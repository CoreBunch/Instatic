/**
 * Card — shared surfaced container primitive for the editor UI.
 *
 * Renders a panel-style background + border + radius. Plugin admin apps,
 * dashboard widget bodies, and any host-side group that needs a panel
 * surface should use this rather than re-declaring the same three rules
 * (`background`, `border`, `border-radius`) in each CSS module.
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no per-prop module classes
 *   - All colours / borders / radii come from `--panel-*` tokens
 *   - Padding is dynamic (numeric prop) so it is passed through inline
 *     `style` — never an actual colour, just a length
 */
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Card.module.css'

interface CardProps {
  /** Inner padding in pixels. Defaults to `16`. */
  padding?: number
  /**
   * Whether to render the surfaced background + border. When `false`, the
   * card is purely a padded container (transparent background, no border).
   * Defaults to `true`.
   */
  bordered?: boolean
  /** Layout escape hatch (e.g. `grid-column: 1 / -1` when nested in a grid). */
  className?: string
  children?: ReactNode
}

export function Card({
  padding = 16,
  bordered = true,
  className,
  children,
}: CardProps) {
  const style: CSSProperties = { padding: `${padding}px` }
  return (
    <div
      className={cn(bordered ? styles.card : styles.cardBare, className)}
      style={style}
    >
      {children}
    </div>
  )
}
