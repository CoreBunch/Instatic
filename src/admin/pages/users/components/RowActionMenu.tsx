/**
 * RowActionMenu — overflow menu for `DataTable` rows.
 *
 * Renders a chevron-down `Button` that toggles a `ContextMenu`. Each item
 * fires its `onSelect` callback and the menu auto-closes. If `items` is
 * empty the menu is omitted entirely (e.g. the owner row has no actions).
 */
import { useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import type { RowActionMenuItem } from '../types'

interface RowActionMenuProps {
  triggerLabel: string
  menuLabel: string
  disabled: boolean
  items: RowActionMenuItem[]
}

export function RowActionMenu({ triggerLabel, menuLabel, disabled, items }: RowActionMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  if (items.length === 0) return null

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="secondary"
        size="xs"
        iconOnly
        disabled={disabled}
        active={open}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDownIcon size={14} aria-hidden="true" />
      </Button>
      {open && (
        <ContextMenu
          ariaLabel={menuLabel}
          onClose={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              triggerRef.current?.focus()
            }
          }}
          anchorRef={triggerRef}
          side="bottom"
          align="end"
          width={176}
        >
          {items.map((item) => (
            <ContextMenuItem
              key={item.label}
              danger={item.danger}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}
