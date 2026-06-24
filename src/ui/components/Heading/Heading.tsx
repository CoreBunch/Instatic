/**
 * Heading — shared semantic heading primitive for the editor UI.
 *
 * Renders an h1–h6 with the editor's typography tokens applied. The level
 * is the visual + semantic level (we don't decouple them — accessibility
 * over aesthetics).
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles
 *   - Colour comes from `--text`; family from `--font-sans`
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Heading.module.css'

interface HeadingProps {
  level: 1 | 2 | 3 | 4 | 5 | 6
  className?: string
  children?: ReactNode
}

export function Heading({ level, className, children }: HeadingProps) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return <Tag className={cn(styles.heading, className)}>{children}</Tag>
}
