import { useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { cn } from '@ui/cn'
import toolbarStyles from '@site/toolbar/Toolbar.module.css'
import type { AdminNavEntry } from './navEntry'

interface AdminNavMoreMenuProps {
  triggerRef: RefObject<HTMLButtonElement | null>
  /** The entries that did not fit in the row. Empty hides the trigger. */
  entries: AdminNavEntry[]
  /** Trigger position in px from the row's left edge. */
  left: number
  onNavigate: (to: string) => void
}

/**
 * The trailing "More" trigger of the admin section navigation, and the menu
 * holding every entry the row had no room for.
 *
 * The trigger is always rendered so its width can be measured before it is
 * needed; with nothing to show it is invisible and out of the tab order.
 */
export function AdminNavMoreMenu({ triggerRef, entries, left, onNavigate }: AdminNavMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const needed = entries.length > 0
  const holdsActiveSection = entries.some((entry) => entry.active)
  const badge = entries.find((entry) => entry.badge)?.badge

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="xs"
        type="button"
        className={cn(toolbarStyles.adminNavMore, !needed && toolbarStyles.adminNavOutOfRow)}
        style={{ '--admin-nav-more-left': `${left}px` } as CSSProperties}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        data-current={holdsActiveSection ? 'true' : undefined}
        data-testid="admin-nav-more"
        onClick={() => setOpen((current) => !current)}
      >
        <span>More</span>
        {badge}
        <ChevronDownIcon size={10} aria-hidden="true" />
      </Button>
      {open && needed && typeof document !== 'undefined' && createPortal(
        <ContextMenu
          ariaLabel="More admin sections"
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          side="bottom"
          align="start"
          zIndex={10000}
        >
          {entries.map((entry) => (
            <ContextMenuItem
              key={entry.key}
              active={entry.active}
              aria-current={entry.active ? 'page' : undefined}
              onClick={() => {
                setOpen(false)
                onNavigate(entry.to)
              }}
            >
              {entry.icon}
              <span>{entry.label}</span>
              {entry.badge}
            </ContextMenuItem>
          ))}
        </ContextMenu>,
        document.body,
      )}
    </>
  )
}
