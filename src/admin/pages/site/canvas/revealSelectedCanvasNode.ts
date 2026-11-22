import { useEditorStore } from '@site/store/store'
import { findRenderedCanvasNodes } from './canvasNodeLookup'
import { measureCanvasElementRect } from './canvasOverlayGeometry'

/** Focus the active frame and reveal its selected node after a phone panel closes. */
export function revealSelectedCanvasNode(nodeId: string) {
  const state = useEditorStore.getState()
  const root = document.querySelector<HTMLElement>('[data-instatic-canvas-root]')
  if (!root || state.selectedNodeId !== nodeId) return
  root.focus({ preventScroll: true })
  const rendered = findRenderedCanvasNodes(nodeId).find(({ frame }) =>
    frame.contentDocument?.body.dataset.breakpointId === state.activeBreakpointId,
  )
  if (!rendered) return
  const rect = measureCanvasElementRect(rendered.element, rendered.frame, root)
  if (!rect) return
  const dx = panIntoView(rect.x - root.scrollLeft, rect.width, root.clientWidth)
  const dy = panIntoView(rect.y - root.scrollTop, rect.height, root.clientHeight)
  if (dx || dy) state.setPan(state.panX + dx, state.panY + dy)
}

function panIntoView(start: number, size: number, visibleSize: number): number {
  const end = start + size
  if (start >= 0 && end <= visibleSize) return 0
  if (start <= 0 && end >= visibleSize) return 0
  return (visibleSize - Math.min(size, visibleSize)) / 2 - start
}
