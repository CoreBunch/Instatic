/**
 * useCanvasLayerContextMenu — state for the canvas right-click menu.
 *
 * Hook lives in a sibling `.ts` file (not `CanvasLayerContextMenu.tsx`) so
 * Fast Refresh keeps working — the project rule is that `.tsx` files only
 * export components.
 */

import { useState } from 'react'

export interface CanvasContextMenuPosition {
  x: number
  y: number
  nodeId: string
}

interface CanvasLayerContextMenuApi {
  position: CanvasContextMenuPosition | null
  open: (position: CanvasContextMenuPosition) => void
  close: () => void
}

export function useCanvasLayerContextMenu(): CanvasLayerContextMenuApi {
  const [position, setPosition] = useState<CanvasContextMenuPosition | null>(null)

  const open = (next: CanvasContextMenuPosition) => {
    setPosition(next)
  }

  const close = () => {
    setPosition(null)
  }

  return { position, open, close }
}
