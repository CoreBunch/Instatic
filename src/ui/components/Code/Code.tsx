/**
 * Code — shared monospace code-block primitive for the editor UI.
 *
 * Renders a `<pre>` with a darkened surface, mono font, border, and
 * horizontal-scroll overflow. Used by plugin admin apps to display
 * snippets, logs, or any preformatted text.
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles
 *   - Surface background comes from `--code-bg`; font from `--font-mono`
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Code.module.css'

interface CodeProps {
  className?: string
  children?: ReactNode
}

export function Code({ className, children }: CodeProps) {
  return <pre className={cn(styles.code, className)}>{children}</pre>
}
