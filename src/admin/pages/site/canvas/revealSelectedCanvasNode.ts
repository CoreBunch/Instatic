import { useEditorStore } from '@site/store/store'
import { findRenderedCanvasNodes } from './canvasNodeLookup'
import { measureCanvasElementRect } from './canvasOverlayGeometry'

/** Focus the active frame and reveal its selected node after a phone panel closes. */
export function revealSelectedCanvasNode(nodeId: string) {
  if (useEditorStore.getState().selectedNodeId !== nodeId) return
  document.querySelector<HTMLElement>('[data-instatic-canvas-root]')?.focus({ preventScroll: true })
  panSelectedCanvasNodeIntoView(nodeId)
}

/** Reveal the selection without moving keyboard focus away from the picker. */
export function panSelectedCanvasNodeIntoView(nodeId: string): boolean {
  const state = useEditorStore.getState()
  const root = document.querySelector<HTMLElement>('[data-instatic-canvas-root]')
  if (!root) return false
  const rendered = findRenderedCanvasNodes(nodeId).find(({ frame }) =>
    frame.contentDocument?.body.dataset.breakpointId === state.activeBreakpointId,
  )
  if (!rendered) return false
  const rect = measureCanvasElementRect(rendered.element, rendered.frame, root)
  if (!rect) return false
  const dx = panIntoView(rect.x - root.scrollLeft, rect.width, root.clientWidth)
  const dy = panIntoView(rect.y - root.scrollTop, rect.height, root.clientHeight)
  if (dx || dy) state.setPan(state.panX + dx, state.panY + dy)
  return true
}

function panIntoView(start: number, size: number, visibleSize: number): number {
  const end = start + size
  if (start >= 0 && end <= visibleSize) return 0
  if (start <= 0 && end >= visibleSize) return 0
  return (visibleSize - Math.min(size, visibleSize)) / 2 - start
}
