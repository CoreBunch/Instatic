/**
 * Text — shared body-text primitive for the editor UI.
 *
 * Renders a `<p>` styled to the editor's typography tokens. Use `variant`
 * to switch between default body text, muted hints, strong-weight body,
 * and inline monospace. Use `size` for `sm` (11px) / `md` (13px, default)
 * / `lg` (15px).
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles
 *   - All colours come from `--editor-text*` tokens
 *   - Variants compose via a module-class array, never via `style`
 */
import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import styles from './Text.module.css'

interface TextProps {
  variant?: 'default' | 'muted' | 'strong' | 'mono'
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children?: ReactNode
}

export function Text({
  variant = 'default',
  size = 'md',
  className,
  children,
}: TextProps) {
  return (
    <p
      className={cn(
        styles.text,
        variant === 'muted' && styles.textMuted,
        variant === 'strong' && styles.textStrong,
        variant === 'mono' && styles.textMono,
        size === 'sm' && styles.textSm,
        size === 'lg' && styles.textLg,
        className,
      )}
    >
      {children}
    </p>
  )
}
