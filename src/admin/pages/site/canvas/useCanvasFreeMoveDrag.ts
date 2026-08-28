/**
 * useCanvasFreeMoveDrag — drag a positioned element to move it on the canvas.
 *
 * When the selected element's computed `position` honours offsets
 * (relative / absolute / fixed), the selection toolbar's hand-grab drag moves
 * the element itself — writing `top` / `left` through the same
 * active-style-target resolution the Properties panel and gradient gizmo use
 * (class rule, breakpoint/condition override, or inline styles) — instead of
 * reordering it in the tree.
 *
 * `sticky` stays a reorder drag: its top/left are scroll constraints, not a
 * free offset, so dragging one around would not track the pointer.
 *
 * `tryBegin` returns false when free-move does not apply (multi-select, no
 * writable style target, element not positioned, locked node) so the caller
 * can fall through to the reorder drag.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { createEmitThrottle } from '@ui/components/ColorPicker'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'

const FREE_MOVE_POSITIONS = new Set(['relative', 'absolute', 'fixed'])

/** Same trailing-throttle window as the gradient gizmo: the pointer is
 *  tracked per event, the heavy store commit (CRDT op + canvas repaint)
 *  lands at most once per window, and the final value flushes on release. */
const EMIT_THROTTLE_MS = 64

interface UseCanvasFreeMoveDragOptions {
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
}

export function useCanvasFreeMoveDrag({
  iframeElement,
  styleTarget,
}: UseCanvasFreeMoveDragOptions) {
  const tryBegin = (event: ReactPointerEvent<HTMLElement>): boolean => {
    if (event.button !== 0 || !styleTarget || !iframeElement) return false

    const state = useEditorStore.getState()
    if (state.selectedNodeIds.length !== 1) return false
    const nodeId = state.selectedNodeIds[0]
    const tree = selectActiveCanvasPage(state)
    const node = tree?.nodes[nodeId]
    if (!node || node.locked) return false

    const doc = iframeElement.contentDocument
    const win = doc?.defaultView
    if (!doc || !win) return false
    const element = doc.querySelector(
      `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`,
    )
    if (!element) return false
    const computed = win.getComputedStyle(element)
    if (!FREE_MOVE_POSITIONS.has(computed.position)) return false

    event.preventDefault()
    event.stopPropagation()

    // Screen-px deltas must be divided by the canvas zoom to become CSS px
    // inside the iframe. The iframe's rendered/layout width ratio IS that
    // scale — the transform layer scales the frame as one box.
    const scale =
      iframeElement.offsetWidth > 0
        ? iframeElement.getBoundingClientRect().width / iframeElement.offsetWidth
        : 1
    // For positioned elements getComputedStyle returns used values in px;
    // `auto` (relative, both sides unset) falls back to 0 — the offset it means.
    const startLeft = parsePx(computed.left)
    const startTop = parsePx(computed.top)
    const startX = event.clientX
    const startY = event.clientY

    // Same cross-iframe plumbing as the reorder drag: capture the pointer for
    // the parent-doc stream, and mark the relay so canvas iframes forward
    // their pointer events back to this window once the cursor enters one.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some test envs reject setPointerCapture; the iframe relay still works.
    }
    markCanvasPointerRelay(event.pointerId)

    // ponytail: createEmitThrottle is string-typed, so the pair rides one
    // "left,top" string; make it generic if a third caller needs objects.
    const emit = createEmitThrottle(EMIT_THROTTLE_MS, (packed) => {
      const [left, top] = packed.split(',')
      styleTarget.writeStyles({ left, top })
    })

    const handleMove = (move: PointerEvent) => {
      move.preventDefault()
      const dx = (move.clientX - startX) / scale
      const dy = (move.clientY - startY) / scale
      emit.push(`${Math.round(startLeft + dx)}px,${Math.round(startTop + dy)}px`)
    }
    const handleEnd = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      clearCanvasPointerRelay()
      emit.flush()
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    return true
  }

  return { tryBegin }
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}
