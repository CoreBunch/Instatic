/**
 * CanvasLayerContextMenu — right-click menu for canvas nodes. `ContextMenu`
 * portals itself to `document.body`, so no wrapper portal is needed here.
 *
 * Pure JSX. Owns no state; the caller drives `position` and `onClose` via
 * `useCanvasLayerContextMenu`. Keeping this component focused means
 * `CanvasRoot` doesn't carry the action-routing boilerplate inline.
 */

import { LayerNodeContextMenu } from '@site/panels/DomPanel/LayerNodeContextMenu'
import type { CanvasContextMenuPosition } from './useCanvasLayerContextMenu'

interface CanvasLayerContextMenuActions {
  requestDeleteNode: (nodeId: string) => void
  duplicateNode: (nodeId: string) => void
  openRenameDialog: (nodeId: string) => void
  wrapNode: (nodeId: string, moduleId: string) => void
  copyNode: (nodeId: string) => void
  cutNode: (nodeId: string) => void
  pasteNode: (nodeId: string) => void
  pasteHtml?: (nodeId: string) => void
}

interface CanvasLayerContextMenuProps {
  position: CanvasContextMenuPosition
  onClose: () => void
  actions: CanvasLayerContextMenuActions
}

export function CanvasLayerContextMenu({
  position,
  onClose,
  actions,
}: CanvasLayerContextMenuProps) {
  return (
    <LayerNodeContextMenu
      x={position.x}
      y={position.y}
      nodeId={position.nodeId}
      onClose={onClose}
      onDelete={() => {
        const id = position.nodeId
        onClose()
        actions.requestDeleteNode(id)
      }}
      onDuplicate={() => {
        actions.duplicateNode(position.nodeId)
        onClose()
      }}
      onRename={() => {
        const { nodeId } = position
        onClose()
        actions.openRenameDialog(nodeId)
      }}
      onWrapInContainer={() => {
        actions.wrapNode(position.nodeId, 'base.container')
        onClose()
      }}
      onCopy={() => {
        actions.copyNode(position.nodeId)
        onClose()
      }}
      onCut={() => {
        actions.cutNode(position.nodeId)
        onClose()
      }}
      onPaste={() => {
        actions.pasteNode(position.nodeId)
        onClose()
      }}
      onPasteHtml={actions.pasteHtml}
    />
  )
}
