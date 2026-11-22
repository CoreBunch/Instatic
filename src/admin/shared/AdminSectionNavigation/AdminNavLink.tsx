import type { MouseEvent, ReactNode } from 'react'
import { Link } from '@admin/lib/routing'
import type { AdminNavEntry } from './navEntry'

export function AdminNavLink({ entry, className, onNavigate, children }: {
  entry: AdminNavEntry
  className: string
  onNavigate: (to: string) => void
  children: ReactNode
}) {
  function followLink(event: MouseEvent<HTMLAnchorElement>) {
    // Modifier keys / non-primary buttons / target=_blank → let the native
    // <a> behaviour run (open-in-new-tab, etc.).
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.currentTarget.target
    ) {
      return
    }
    event.preventDefault()
    onNavigate(entry.to)
  }

  return (
    <Link to={entry.to} className={className} aria-current={entry.active ? 'page' : undefined} onClick={followLink}>
      {children}
    </Link>
  )
}
