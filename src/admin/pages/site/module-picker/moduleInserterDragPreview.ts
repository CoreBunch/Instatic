import type { CSSProperties } from 'react'
import type { CanvasDropPreview } from '@site/canvas/canvasInsertionDrop'
import type { ModuleInserterItem } from './moduleInserterModel'

export interface DragVisualState {
  item: ModuleInserterItem
  x: number
  y: number
  preview: CanvasDropPreview | null
}

export function ghostStyle(drag: DragVisualState): CSSProperties {
  return {
    '--ghost-x': `${drag.x}px`,
    '--ghost-y': `${drag.y}px`,
  } as CSSProperties
}
