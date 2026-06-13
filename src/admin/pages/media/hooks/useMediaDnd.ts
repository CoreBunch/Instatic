/**
 * useMediaDnd — shared drag-and-drop wiring for the Media workspace.
 *
 * Owns the active drop-target highlight plus the dragOver / dragLeave / drop
 * handlers, all delegating their legality decisions to the pure rules in
 * `utils/mediaDnd`. Both the canvas (grid + list) and the sidebar folder tree
 * consume this hook, so a single source governs which media drops are legal.
 */
import { useState, type DragEvent } from 'react'
import { hasMediaDropData, readMediaDropPayload } from '../utils/mediaDragDrop'
import {
  canAcceptDrop,
  commitDropPayload,
  folderDropKey,
  type MediaDndTarget,
} from '../utils/mediaDnd'

interface MediaDnd {
  /** True when `targetFolderId` is the folder currently highlighted as the drop target. */
  isDropTarget: (targetFolderId: string | null) => boolean
  /** Clear the highlight (e.g. on `dragEnd`). */
  clearDropTarget: () => void
  handleDragOver: (event: DragEvent<HTMLElement>, targetFolderId: string | null) => void
  handleDragLeave: (event: DragEvent<HTMLElement>) => void
  handleDrop: (event: DragEvent<HTMLElement>, targetFolderId: string | null) => Promise<void>
}

export function useMediaDnd(workspace: MediaDndTarget): MediaDnd {
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)

  function handleDragOver(event: DragEvent<HTMLElement>, targetFolderId: string | null) {
    if (!hasMediaDropData(event.dataTransfer)) return
    const payload = readMediaDropPayload(event.dataTransfer)
    if (!canAcceptDrop(workspace, payload, targetFolderId)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropTargetKey(folderDropKey(targetFolderId))
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setDropTargetKey(null)
  }

  async function handleDrop(event: DragEvent<HTMLElement>, targetFolderId: string | null) {
    if (!hasMediaDropData(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setDropTargetKey(null)
    const payload = readMediaDropPayload(event.dataTransfer)
    if (!payload || !canAcceptDrop(workspace, payload, targetFolderId)) return
    await commitDropPayload(workspace, payload, targetFolderId)
  }

  return {
    isDropTarget: (targetFolderId) => dropTargetKey === folderDropKey(targetFolderId),
    clearDropTarget: () => setDropTargetKey(null),
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
