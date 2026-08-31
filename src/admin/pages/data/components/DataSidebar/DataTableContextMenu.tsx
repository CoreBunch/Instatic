import { useEffect, useRef, type ReactElement } from 'react'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import type { DataTableListItem } from '@core/data/schemas'

interface DataTableContextMenuProps {
  x: number
  y: number
  table: DataTableListItem
  selected: boolean
  canManage: boolean
  onClose: () => void
  onSelectTable: (tableId: string) => void
  onOpenTableSettings: (tableId: string) => void
  onDeleteTable: (table: DataTableListItem) => void
}

function deleteDisabledReason(table: DataTableListItem, canManage: boolean): string | null {
  if (!canManage) return 'You do not have permission to delete tables.'
  if (table.system) return 'System tables cannot be deleted.'
  if (table.rowCount > 0) return 'Delete all rows before deleting this table.'
  return null
}

export function DataTableContextMenu({
  x,
  y,
  table,
  selected,
  canManage,
  onClose,
  onSelectTable,
  onOpenTableSettings,
  onDeleteTable,
}: DataTableContextMenuProps): ReactElement {
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const deleteReason = deleteDisabledReason(table, canManage)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  function runAndClose(action: () => void): void {
    action()
    onClose()
  }

  return (
    <ContextMenu x={x} y={y} ariaLabel={`${table.pluralLabel} table actions`} onClose={onClose}>
      <ContextMenuItem
        ref={firstItemRef}
        disabled={selected}
        onClick={() => runAndClose(() => onSelectTable(table.id))}
      >
        <span aria-hidden="true"><DatabaseSolidIcon size={13} /></span>
        Open table
      </ContextMenuItem>
      <ContextMenuItem onClick={() => runAndClose(() => onOpenTableSettings(table.id))}>
        <span aria-hidden="true"><Settings2SolidIcon size={13} /></span>
        Table settings
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        danger
        disabled={deleteReason !== null}
        tooltip={deleteReason ?? undefined}
        onClick={() => runAndClose(() => onDeleteTable(table))}
      >
        <span aria-hidden="true"><TrashSolidIcon size={13} /></span>
        Delete table
      </ContextMenuItem>
    </ContextMenu>
  )
}
