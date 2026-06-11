/**
 * SavedLayoutManageMenu — right-click menu on a saved layout in the module
 * inserter: Rename… / Delete.
 *
 * Rename routes through the shared `LayoutNameDialog`, which sits on the
 * standard Dialog layer BELOW the spotlight-level inserter — so the inserter
 * closes first. Delete commits immediately (it is a normal undoable site
 * mutation) and confirms via toast, keeping the inserter open.
 */

import {
  ContextMenu as UIContextMenu,
  ContextMenuItem,
} from '@ui/components/ContextMenu'
import { pushToast } from '@ui/components/Toast'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { useEditorStore } from '@site/store/store'

export interface SavedLayoutMenuState {
  x: number
  y: number
  layoutId: string
  name: string
}

interface SavedLayoutManageMenuProps {
  menu: SavedLayoutMenuState
  /** Close just this menu. */
  onClose: () => void
  /** Close the hosting inserter dialog (rename hands off to LayoutNameDialog). */
  onCloseInserter: () => void
}

export function SavedLayoutManageMenu({
  menu,
  onClose,
  onCloseInserter,
}: SavedLayoutManageMenuProps) {
  const deleteLayout = useEditorStore((s) => s.deleteLayout)
  const openLayoutNameDialog = useEditorStore((s) => s.openLayoutNameDialog)

  function handleRename() {
    onClose()
    onCloseInserter()
    openLayoutNameDialog({ mode: 'rename', layoutId: menu.layoutId })
  }

  function handleDelete() {
    onClose()
    deleteLayout(menu.layoutId)
    pushToast({
      kind: 'success',
      title: `Deleted layout "${menu.name}"`,
      body: 'Undo with Ctrl/Cmd+Z.',
      location: 'module-inserter',
    })
  }

  return (
    <UIContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={`${menu.name} options`}
      onClose={onClose}
    >
      <ContextMenuItem onClick={handleRename}>
        <span aria-hidden="true"><PenSquareSolidIcon size={13} /></span>
        Rename…
      </ContextMenuItem>
      <ContextMenuItem danger onClick={handleDelete}>
        <span aria-hidden="true"><TrashSolidIcon size={13} /></span>
        Delete
      </ContextMenuItem>
    </UIContextMenu>
  )
}
