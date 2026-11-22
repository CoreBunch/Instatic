/**
 * TreeBackgroundContextMenu — right-click menu for the EMPTY background of
 * the DOM panel tree area (i.e. the padding around / below the rendered rows
 * where there is no `TreeNode` to receive the contextmenu event).
 *
 * Per-row right-clicks are handled by `LayerNodeContextMenu` via `TreeNode`;
 * those calls `e.stopPropagation()` on `contextmenu`, so the background-level
 * handler in `DomPanel` only fires for clicks on actual empty space.
 *
 * The menu is intentionally small — just the two actions that are meaningful
 * with no row anchor:
 *   - Paste            — paste the clipboard subtree at the page root
 *   - Insert module    — submenu hosting the shared `ModulePicker` (search +
 *                        categorized modules + site Visual Components)
 *
 * Both actions resolve their target to the active canvas page's `rootNodeId`
 * (the always-present `base.body` per the always-wrap invariant). For paste,
 * `pasteNode(rootId)` lands inside root because root accepts children. For
 * insert, `useInsertModule(mod, rootId)` and `insertComponentRef(rootId, vcId)`
 * both honor the explicit parent.
 */

import { useEffect, useRef } from 'react'
import {
  ContextMenu as UIContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenu,
} from '@ui/components/ContextMenu'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { useInsertModule } from '@site/hooks/useInsertModule'
import { ModulePicker } from '@site/module-picker'
import type { AnyModuleDefinition } from '@core/module-engine'
import { FilesStack2SolidIcon } from 'pixel-art-icons/icons/files-stack-2-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { isNarrowEditorChromeViewport } from '@site/layout/responsiveChrome'

interface TreeBackgroundContextMenuProps {
  x: number
  y: number
  onClose: () => void
}

export function TreeBackgroundContextMenu({
  x,
  y,
  onClose,
}: TreeBackgroundContextMenuProps) {
  const firstItemRef = useRef<HTMLButtonElement>(null)

  const rootNodeId = useEditorStore(
    (s) => selectActiveCanvasPage(s)?.rootNodeId ?? null,
  )
  const insertComponentRef = useEditorStore((s) => s.insertComponentRef)
  const pasteNodeAction = useEditorStore((s) => s.pasteNode)
  const insertModule = useInsertModule()

  // Reactive boolean for the conditional Paste item — re-renders whenever
  // the clipboard entry transitions between null and non-null.
  const canPaste = useEditorStore((s) => s.clipboardEntry !== null)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  const handlePaste = () => {
    if (!rootNodeId) return
    pasteNodeAction(rootNodeId)
    onClose()
  }

  const handleSelectModule = (mod: AnyModuleDefinition) => {
    if (!rootNodeId) return
    insertModule(mod, rootNodeId, {
      propertiesPanel: isNarrowEditorChromeViewport() ? 'preserve' : 'open',
    })
    onClose()
  }

  const handleSelectVC = (vcId: string) => {
    if (!rootNodeId) return
    insertComponentRef(rootNodeId, vcId)
    onClose()
  }

  // Without an active canvas page we have no root to anchor to — render
  // nothing. The menu is effectively a no-op in that state and showing
  // disabled items would just be noise.
  if (!rootNodeId) return null

  return (
    <UIContextMenu
      x={x}
      y={y}
      ariaLabel="Tree background options"
      animateExit
      onClose={onClose}
    >
      {canPaste && (
        <>
          <ContextMenuItem ref={firstItemRef} onClick={handlePaste}>
            <span aria-hidden="true"><FilesStack2SolidIcon size={13} /></span>
            Paste
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}

      <ContextMenuSubmenu
        label="Insert module"
        icon={<PlusIcon size={13} />}
        onClose={onClose}
        width={280}
        maxHeight={420}
        // The submenu hosts a search input — clicks on the input must not
        // dismiss the panel. Only menuitem clicks (i.e. picking a module/VC)
        // should close.
        closeOnItemClickOnly
      >
        <ModulePicker
          onSelectModule={handleSelectModule}
          onSelectVC={handleSelectVC}
        />
      </ContextMenuSubmenu>
    </UIContextMenu>
  )
}
