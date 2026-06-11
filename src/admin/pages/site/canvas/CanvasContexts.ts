import { createContext, type MouseEvent, type RefObject } from 'react'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'

interface CanvasSelectionContextValue {
  onNodeClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
  onNodeHover: (nodeId: string | null, breakpointId?: string) => void
  onNodeContextMenu: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
  onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
}

export const CanvasSelectionContext = createContext<CanvasSelectionContextValue>({
  onNodeClick: () => {},
  onNodeHover: () => {},
  onNodeContextMenu: () => {},
  onNodeDoubleClick: () => {},
})

interface CanvasViewportActionsContextValue {
  canvasRootRef: RefObject<HTMLElement | null>
  panBy: (dx: number, dy: number) => void
}

export const CanvasViewportActionsContext =
  createContext<CanvasViewportActionsContextValue | null>(null)

export const CanvasBreakpointContext = createContext<string | undefined>(undefined)
export const CanvasTemplateContext = createContext<TemplateRenderDataContext | undefined>(undefined)
