/**
 * SplitButton — a primary action button fused to a chevron trigger that opens a
 * dropdown of related actions. Clicking the left half runs the default action;
 * clicking the chevron reveals the full menu.
 *
 * Composes the shared Button + ContextMenu primitives. Both halves share a
 * variant and size and render as one seam-joined control (inner corners squared,
 * a 1px divider between them). The menu is portalled above editor panels.
 *
 * Used by the editor's Publish control (PublishActionGroup) and the Typography
 * panel's add-font control (FontsSection).
 */
import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { Button, type ButtonProps } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ChevronDown2Icon } from 'pixel-art-icons/icons/chevron-down-2'
import type { IconComponent } from 'pixel-art-icons/types'
import styles from './SplitButton.module.css'

export interface SplitButtonMenuItem {
  id: string
  label: string
  /** Optional leading icon for the menu row. */
  icon?: IconComponent
  disabled?: boolean
  onSelect: () => void | Promise<void>
  testId?: string
}

export interface SplitButtonProps {
  /** Primary button content (usually a short label). */
  label: ReactNode
  /** Default action, run when the left half is clicked. */
  onClick: () => void | Promise<void>
  /** Dropdown items revealed by the chevron trigger. */
  menuItems: SplitButtonMenuItem[]
  /** Optional leading icon on the primary half. */
  icon?: IconComponent
  /** Shared button variant for both halves. Default `secondary`. */
  variant?: ButtonProps['variant']
  /** Shared button size for both halves. Default `sm`. */
  size?: ButtonProps['size']
  /** Disables the primary half only — the chevron trigger stays usable. */
  disabled?: boolean
  /** Spins the leading icon and sets `aria-busy` on the primary half. */
  busy?: boolean
  /** Accessible label for the primary half. Falls back to `label` when it is a string. */
  primaryAriaLabel?: string
  /** Tooltip for the primary half. */
  primaryTooltip?: ReactNode
  /** Accessible label + tooltip for the chevron trigger. Default `More actions`. */
  menuTriggerLabel?: string
  /** Accessible label for the menu popup. Falls back to `menuTriggerLabel`. */
  menuLabel?: string
  /** Menu width in px. Default 184. */
  menuWidth?: number
  /** Optional state token surfaced as `data-state` on the primary half for styling. */
  primaryState?: string
  /** Extra class on the wrapper. */
  className?: string
  /** Extra class on the primary half. */
  primaryClassName?: string
  /** Extra class on the chevron trigger. */
  triggerClassName?: string
  primaryTestId?: string
  menuTriggerTestId?: string
  menuTestId?: string
}

const DEFAULT_MENU_WIDTH = 184
const MENU_GAP = 6

export function SplitButton({
  label,
  onClick,
  menuItems,
  icon: PrimaryIcon,
  variant = 'secondary',
  size = 'sm',
  disabled = false,
  busy = false,
  primaryAriaLabel,
  primaryTooltip,
  menuTriggerLabel = 'More actions',
  menuLabel,
  menuWidth = DEFAULT_MENU_WIDTH,
  primaryState,
  className,
  primaryClassName,
  triggerClassName,
  primaryTestId,
  menuTriggerTestId,
  menuTestId,
}: SplitButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  function closeMenu() {
    setMenuOpen(false)
    triggerRef.current?.focus()
  }

  function handleSelect(item: SplitButtonMenuItem) {
    if (item.disabled) return
    setMenuOpen(false)
    void item.onSelect()
  }

  const resolvedAriaLabel =
    primaryAriaLabel ?? (typeof label === 'string' ? label : undefined)

  return (
    <div className={cn(styles.group, className)}>
      <Button
        variant={variant}
        size={size}
        className={cn(styles.primary, primaryClassName)}
        aria-label={resolvedAriaLabel}
        aria-busy={busy || undefined}
        tooltip={primaryTooltip}
        onClick={() => void onClick()}
        disabled={disabled}
        data-state={primaryState}
        data-testid={primaryTestId}
      >
        {PrimaryIcon && (
          <PrimaryIcon
            size={13}
            className={cn(busy && styles.spinIcon)}
            aria-hidden="true"
          />
        )}
        <span>{label}</span>
      </Button>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        iconOnly
        className={cn(styles.trigger, triggerClassName)}
        aria-label={menuTriggerLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        tooltip={menuTriggerLabel}
        onClick={() => setMenuOpen((open) => !open)}
        disabled={menuItems.length === 0}
        data-testid={menuTriggerTestId}
      >
        <ChevronDown2Icon size={13} aria-hidden="true" />
      </Button>

      {menuOpen && typeof document !== 'undefined' && createPortal(
        <ContextMenu
          id={menuId}
          anchorRef={triggerRef}
          side="auto"
          align="end"
          offset={MENU_GAP}
          width={menuWidth}
          minWidth={menuWidth}
          zIndex={10000}
          ariaLabel={menuLabel ?? menuTriggerLabel}
          onClose={closeMenu}
          data-testid={menuTestId}
        >
          {menuItems.map((item) => {
            const ItemIcon = item.icon
            return (
              <ContextMenuItem
                key={item.id}
                disabled={item.disabled}
                onClick={() => handleSelect(item)}
                data-testid={item.testId}
              >
                {ItemIcon && (
                  <span aria-hidden="true">
                    <ItemIcon size={14} />
                  </span>
                )}
                <span>{item.label}</span>
              </ContextMenuItem>
            )
          })}
        </ContextMenu>,
        document.body,
      )}
    </div>
  )
}
