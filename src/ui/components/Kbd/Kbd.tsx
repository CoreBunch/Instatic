/**
 * Kbd — shared keycap primitive.
 *
 * `Kbd` renders a single keycap (one key). `ShortcutKeys` takes a full
 * shortcut label (e.g. "⌘K") and renders one keycap per token, wrapped in a
 * sequence container.
 *
 * These replace the hand-rolled `<kbd>`/`<span>` keycaps that were styled
 * three different ways across the admin UI.
 */

import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import { splitShortcut } from './splitShortcut'
import styles from './Kbd.module.css'

interface KbdProps {
  children: ReactNode
  className?: string
}

export function Kbd({ children, className }: KbdProps): ReactNode {
  return <kbd className={cn(styles.kbd, className)}>{children}</kbd>
}

interface ShortcutKeysProps {
  /** Full shortcut label, e.g. "⌘K" or "Ctrl+Shift+P". */
  label: string
  /** Marked aria-hidden by default since the parent usually labels the action. */
  'aria-hidden'?: boolean | 'true' | 'false'
  className?: string
}

export function ShortcutKeys({
  label,
  'aria-hidden': ariaHidden = 'true',
  className,
}: ShortcutKeysProps): ReactNode {
  const parts = splitShortcut(label)
  return (
    <span className={cn(styles.sequence, className)} aria-hidden={ariaHidden}>
      {parts.map((part, i) => (
        <Kbd key={i}>{part}</Kbd>
      ))}
    </span>
  )
}
