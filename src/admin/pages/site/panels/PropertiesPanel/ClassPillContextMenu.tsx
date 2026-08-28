/** ClassPillContextMenu — right-click menu for an assigned class pill, plus its portal wrapper. */

import { useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { isGeneratedClassLocked, type StyleRule } from '@core/page-tree'
import type { ClassContextMenuState } from './classPickerUiState'

interface PillContextMenuPortalProps {
  contextMenu: ClassContextMenuState | null
  contextClass: StyleRule | null
  contextClassIndex: number
  visibleAssignedCount: number
  onClose: () => void
  onEdit: (cls: StyleRule) => void
  onRename: (cls: StyleRule) => void
  onMove: (cls: StyleRule, direction: 'up' | 'down') => void
  onRemove: (cls: StyleRule) => void
}

export function PillContextMenuPortal({
  contextMenu,
  contextClass,
  contextClassIndex,
  visibleAssignedCount,
  onClose,
  onEdit,
  onRename,
  onMove,
  onRemove,
}: PillContextMenuPortalProps): React.ReactPortal | null {
  if (!contextMenu || !contextClass) return null
  const locked = isGeneratedClassLocked(contextClass)
  const runAndClose = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return createPortal(
    <ClassPillContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      canMoveUp={contextClassIndex > 0}
      canMoveDown={contextClassIndex >= 0 && contextClassIndex < visibleAssignedCount - 1}
      locked={locked}
      onClose={onClose}
      onEdit={runAndClose(() => onEdit(contextClass))}
      onRename={runAndClose(() => {
        if (!locked) onRename(contextClass)
      })}
      onMoveUp={runAndClose(() => onMove(contextClass, 'up'))}
      onMoveDown={runAndClose(() => onMove(contextClass, 'down'))}
      onRemove={runAndClose(() => onRemove(contextClass))}
    />,
    document.body,
  )
}

function ClassPillContextMenu({
  x,
  y,
  canMoveUp,
  canMoveDown,
  onClose,
  onEdit,
  onRename,
  onMoveUp,
  onMoveDown,
  onRemove,
  locked,
}: {
  x: number
  y: number
  canMoveUp: boolean
  canMoveDown: boolean
  locked: boolean
  onClose: () => void
  onEdit: () => void
  onRename: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  return (
    <ContextMenu x={x} y={y} ariaLabel="Class actions" onClose={onClose}>
      <ContextMenuItem ref={firstItemRef} onClick={onEdit}>
        <span aria-hidden="true"><EditSolidIcon size={13} /></span>
        {locked ? 'View utility' : 'Edit styles'}
      </ContextMenuItem>
      <ContextMenuItem disabled={locked} onClick={onRename}>
        <span aria-hidden="true"><EditSolidIcon size={13} /></span>
        Rename
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!canMoveUp} onClick={onMoveUp}>
        <span aria-hidden="true"><ChevronUpIcon size={13} /></span>
        Move up
      </ContextMenuItem>
      <ContextMenuItem disabled={!canMoveDown} onClick={onMoveDown}>
        <span aria-hidden="true"><ChevronDownIcon size={13} /></span>
        Move down
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem danger onClick={onRemove}>
        <span aria-hidden="true"><RemoveXGlyph /></span>
        Remove from this element
      </ContextMenuItem>
    </ContextMenu>
  )
}
