/**
 * useCanvasNodeRect — plugin canvas overlay geometry.
 *
 * The hook must resolve the node inside the per-breakpoint canvas IFRAMES
 * (never the admin document, where layers-tree rows / overlay rings carry the
 * same `data-node-id`) and translate the iframe-internal rect through the
 * canvas zoom into overlay-layer-relative coordinates.
 *
 * happy-dom reports zero rects for everything, so the fixtures stub
 * `getBoundingClientRect` / `offsetWidth` with known geometry.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { renderHook, cleanup } from '@testing-library/react'
import { useCanvasNodeRect } from '@admin/plugin-host-hooks'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function stubRect(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }),
  })
}

/** Overlay layer + one canvas frame containing the node, with known geometry. */
function setUpCanvas(nodeId: string) {
  const layer = document.createElement('div')
  layer.setAttribute('data-canvas-overlay-layer', 'true')
  stubRect(layer, { left: 100, top: 50, width: 800, height: 600 })
  document.body.appendChild(layer)

  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const frameDoc = frame.contentDocument!
  frameDoc.body.setAttribute('data-breakpoint-id', 'bp-desktop')
  // The iframe element renders at half its internal width → canvas zoom 0.5.
  Object.defineProperty(frame, 'offsetWidth', { configurable: true, value: 1440 })
  stubRect(frame, { left: 200, top: 80, width: 720, height: 450 })

  const node = frameDoc.createElement('div')
  node.setAttribute('data-node-id', nodeId)
  frameDoc.body.appendChild(node)
  stubRect(node, { left: 40, top: 20, width: 100, height: 60 })

  return { layer, frame, node }
}

describe('useCanvasNodeRect', () => {
  it('measures the canvas-frame node, zoom-translated, relative to the overlay layer', () => {
    setUpCanvas('hero')
    // An admin-document carrier of the same id (e.g. a layers-tree row) must
    // not shadow the rendered node.
    const treeRow = document.createElement('div')
    treeRow.setAttribute('data-node-id', 'hero')
    stubRect(treeRow, { left: 1, top: 2, width: 3, height: 4 })
    document.body.appendChild(treeRow)

    const { result } = renderHook(() => useCanvasNodeRect('hero'))

    // zoom = 720 / 1440 = 0.5
    // left = (frame.left + node.left * 0.5) - layer.left = 200 + 20 - 100
    // top  = (frame.top  + node.top  * 0.5) - layer.top  =  80 + 10 -  50
    expect(result.current).toEqual({ left: 120, top: 40, width: 50, height: 30 })
  })

  it('returns null when the node renders in no canvas frame, even if admin chrome carries the id', () => {
    setUpCanvas('other-node')
    const ring = document.createElement('div')
    ring.setAttribute('data-node-id', 'hero')
    ring.setAttribute('data-canvas-selection-ring', 'true')
    stubRect(ring, { left: 5, top: 5, width: 10, height: 10 })
    document.body.appendChild(ring)

    const { result } = renderHook(() => useCanvasNodeRect('hero'))
    expect(result.current).toBeNull()
  })

  it('returns null for a null node id', () => {
    setUpCanvas('hero')
    const { result } = renderHook(() => useCanvasNodeRect(null))
    expect(result.current).toBeNull()
  })
})
