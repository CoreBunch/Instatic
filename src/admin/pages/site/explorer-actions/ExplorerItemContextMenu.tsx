import { useEffect, useRef, type ReactNode } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenu,
} from '@ui/components/ContextMenu'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import styles from './ExplorerItemContextMenu.module.css'

interface ExplorerContextMenuAction {
  kind?: 'action'
  label: string
  action: () => void
  icon: ReactNode
  danger?: boolean
  disabled?: boolean
}

interface ExplorerContextMenuSubmenu {
  kind: 'submenu'
  label: string
  icon: ReactNode
  /**
   * Submenu items rendered in the nested panel. Each item is a leaf action;
   * nested submenus are intentionally not supported (one level deep is enough
   * for explorer-style menus and keeps focus management simple).
   */
  items: ExplorerContextMenuAction[]
  /**
   * When the submenu has zero items, the trigger row is omitted entirely
   * rather than rendered disabled. Defaults to true — set to false to keep
   * the row visible (disabled) for affordance.
   */
  hideWhenEmpty?: boolean
  /** Submenu panel width in px. Default: 200. */
  width?: number
}

export type ExplorerContextMenuItem = ExplorerContextMenuAction | ExplorerContextMenuSubmenu

interface ExplorerItemContextMenuProps {
  x: number
  y: number
  ariaLabel: string
  onClose: () => void
  onRename: () => void
  onDelete: () => void
  headerLabel?: string
  renameLabel?: string
  deleteLabel?: string
  showRename?: boolean
  showDelete?: boolean
  renameDisabled?: boolean
  deleteDisabled?: boolean
  extraItems?: ExplorerContextMenuItem[]
}

export function ExplorerItemContextMenu({
  x,
  y,
  ariaLabel,
  onClose,
  onRename,
  onDelete,
  headerLabel,
  renameLabel = 'Rename',
  deleteLabel = 'Delete',
  showRename = true,
  showDelete = true,
  renameDisabled = false,
  deleteDisabled = false,
  extraItems = [],
}: ExplorerItemContextMenuProps) {
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  const items: ExplorerContextMenuItem[] = [
    ...extraItems,
    ...(showRename ? [{
      kind: 'action' as const,
      label: renameLabel,
      action: onRename,
      icon: <EditSolidIcon size={13} />,
      disabled: renameDisabled,
    }] : []),
    ...(showDelete ? [{
      kind: 'action' as const,
      label: deleteLabel,
      action: onDelete,
      icon: <TrashSolidIcon size={13} />,
      danger: true,
      disabled: deleteDisabled,
    }] : []),
  ]

  let firstActionAssigned = false

  return (
    <ContextMenu x={x} y={y} ariaLabel={ariaLabel} animateExit onClose={onClose}>
      {headerLabel && (
        <>
          <div role="presentation" className={styles.headerChip}>
            {headerLabel}
          </div>
          <ContextMenuSeparator />
        </>
      )}
      {items.map((item) => {
        if (item.kind === 'submenu') {
          if ((item.hideWhenEmpty ?? true) && item.items.length === 0) return null
          return (
            <ContextMenuSubmenu
              key={item.label}
              label={item.label}
              icon={item.icon}
              onClose={onClose}
              width={item.width ?? 200}
            >
              {item.items.map((sub) => (
                <ContextMenuItem
                  key={sub.label}
                  danger={sub.danger ?? false}
                  disabled={sub.disabled}
                  onClick={sub.action}
                >
                  <span aria-hidden="true">{sub.icon}</span>
                  {sub.label}
                </ContextMenuItem>
              ))}
            </ContextMenuSubmenu>
          )
        }

        const isFirst = !firstActionAssigned
        if (isFirst) firstActionAssigned = true
        return (
          <ContextMenuItem
            key={item.label}
            ref={isFirst ? firstItemRef : undefined}
            danger={item.danger ?? false}
            disabled={item.disabled}
            onClick={item.action}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </ContextMenuItem>
        )
      })}
    </ContextMenu>
  )
}
