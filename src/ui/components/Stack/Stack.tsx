/**
 * Stack — shared flex-layout primitive for the editor UI.
 *
 * The admin and editor codebase builds vertical / horizontal flex layouts
 * everywhere; until now every panel did it inline with CSS modules + custom
 * flex declarations. This primitive centralises that pattern so admin pages,
 * plugin admin apps, and dashboard widgets all express layout the same way.
 *
 * Defaults: column direction, 8px gap, no alignment / justification / wrap.
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no per-prop module classes
 *   - Dynamic numeric / enum values are passed through CSS custom properties
 *     read back by the static module, never via inline `style={{ color: … }}`
 *     for colours (none here — Stack carries no colour)
 */
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Stack.module.css'

interface StackProps {
  /** Flex direction. Defaults to `'column'`. */
  direction?: 'row' | 'column'
  /** Gap between children, in px. Defaults to `8`. */
  gap?: number
  /** `align-items`. */
  align?: 'start' | 'center' | 'end' | 'stretch'
  /** `justify-content`. */
  justify?: 'start' | 'center' | 'end' | 'between' | 'around'
  /** Whether children wrap onto new lines. */
  wrap?: boolean
  /**
   * Fixed height for the flex container. Useful when children use
   * `margin-top: auto` (e.g. chart primitives) to push themselves to the
   * bottom of a column Stack. Accepts a pixel count (`180` → `"180px"`)
   * or any CSS length string (`"100%"`, `"12rem"`).
   */
  height?: number | string
  /** Layout escape hatch (e.g. `grid-column: 1 / -1` when nested in a grid). */
  className?: string
  children?: ReactNode
}

const alignMap = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
} as const

const justifyMap = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
} as const

export function Stack({
  direction = 'column',
  gap = 8,
  align,
  justify,
  wrap,
  height,
  className,
  children,
}: StackProps) {
  const style: CSSProperties & Record<string, string | undefined> = {
    flexDirection: direction,
    gap: `${gap}px`,
    alignItems: align ? alignMap[align] : undefined,
    justifyContent: justify ? justifyMap[justify] : undefined,
    flexWrap: wrap ? 'wrap' : 'nowrap',
    height: typeof height === 'number' ? `${height}px` : height,
  }
  return (
    <div className={cn(styles.stack, className)} style={style}>
      {children}
    </div>
  )
}
