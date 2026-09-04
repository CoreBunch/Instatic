/**
 * useCanvasFreeMoveDrag — drag a positioned element to move it on the canvas.
 *
 * When the selected element's computed `position` honours offsets
 * (relative / absolute / fixed), the selection toolbar's hand-grab drag moves
 * the element itself — rewriting every offset side the active style target
 * stores (`right` / `bottom` get their mirrored delta; `left` / `top` are
 * introduced only when their axis has no opposite-edge anchor) through the
 * same active-style-target resolution the Properties panel and gradient gizmo
 * use (class rule, breakpoint/condition override, or inline styles) — instead
 * of reordering it in the tree.
 *
 * Gesture model (preview/commit split): pointer moves write the element's
 * INLINE style inside the iframe — no store commit, no CRDT op, no React
 * re-render per move. ONE commit lands on release (the inline preview is held
 * two frames so the committed CSS takes over without a flash); Escape
 * mid-drag restores the pre-drag inline style and commits nothing.
 *
 * Smart guides: while dragging, the moved box snaps (±4 screen px) to the
 * edges and centres of its siblings and its parent's box. An accent hairline
 * is drawn over the canvas root at the matched coordinate — created and
 * positioned imperatively, so the hot path stays free of React.
 *
 * `sticky` stays a reorder drag: its top/left are scroll constraints, not a
 * free offset, so dragging one around would not track the pointer.
 *
 * Pinned inset edges (`lockedInsetSides`, session-only selection state set by
 * the Position section's pinbox) freeze their axis: a pinned top or bottom
 * freezes vertical movement (no `top` write), a pinned left or right freezes
 * horizontal (no `left` write).
 *
 * `tryBegin` returns false when free-move does not apply (multi-select, no
 * writable style target, element not positioned, locked node, both axes
 * pinned) so the caller can fall through to the reorder drag.
 */

import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'
import { restoreInline, saveInline } from './canvasStyleGesture'
import styles from './BreakpointSelectionOverlay.module.css'

const FREE_MOVE_POSITIONS = new Set(['relative', 'absolute', 'fixed'])

/** Snap radius in SCREEN px — constant feel at every zoom level. */
const SNAP_THRESHOLD_PX = 4
/** Guard against measuring hundreds of siblings every drag start. */
const MAX_SNAP_SIBLINGS = 60

interface UseCanvasFreeMoveDragOptions {
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
  /** Canvas root the smart-guide hairlines are appended to (null → no guides). */
  canvasRootRef?: RefObject<HTMLElement | null>
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface SnapCandidate {
  /** The aligned coordinate, in iframe CSS px. */
  coord: number
  /** The rect that produced it — the guide spans it and the moved box. */
  rect: Rect
}

interface SnapHit {
  coord: number
  adjust: number
  rect: Rect
}

function toRect(domRect: DOMRect): Rect {
  return { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height }
}

/** Edges + centre of `rect` on one axis, as snap candidates. */
function axisCandidates(rect: Rect, axis: 'x' | 'y'): SnapCandidate[] {
  const start = axis === 'x' ? rect.left : rect.top
  const size = axis === 'x' ? rect.width : rect.height
  return [
    { coord: start, rect },
    { coord: start + size / 2, rect },
    { coord: start + size, rect },
  ]
}

/**
 * Best snap for the moved box on one axis: its three edges (start / centre /
 * end) against every candidate coordinate. Returns null when nothing is
 * within the threshold.
 */
function bestSnap(
  start: number,
  size: number,
  candidates: SnapCandidate[],
  threshold: number,
): SnapHit | null {
  const myEdges = [start, start + size / 2, start + size]
  let best: SnapHit | null = null
  for (const candidate of candidates) {
    for (const edge of myEdges) {
      const diff = candidate.coord - edge
      if (Math.abs(diff) > threshold) continue
      if (best === null || Math.abs(diff) < Math.abs(best.adjust)) {
        best = { coord: candidate.coord, adjust: diff, rect: candidate.rect }
      }
    }
  }
  return best
}

/** Imperative pair of guide hairlines living in the canvas root during a drag. */
function createGuideLines(canvasRoot: HTMLElement | null) {
  if (!canvasRoot) {
    return { showV: () => {}, showH: () => {}, hideV: () => {}, hideH: () => {}, destroy: () => {} }
  }
  const make = () => {
    const line = canvasRoot.ownerDocument.createElement('div')
    line.className = styles.smartGuide
    line.style.display = 'none'
    canvasRoot.appendChild(line)
    return line
  }
  const v = make()
  const h = make()
  return {
    showV(x: number, y1: number, y2: number) {
      v.style.display = ''
      v.style.transform = `translate(${x}px, ${y1}px)`
      v.style.width = '1px'
      v.style.height = `${Math.max(0, y2 - y1)}px`
    },
    showH(y: number, x1: number, x2: number) {
      h.style.display = ''
      h.style.transform = `translate(${x1}px, ${y}px)`
      h.style.height = '1px'
      h.style.width = `${Math.max(0, x2 - x1)}px`
    },
    hideV() {
      v.style.display = 'none'
    },
    hideH() {
      h.style.display = 'none'
    },
    destroy() {
      v.remove()
      h.remove()
    },
  }
}

export function useCanvasFreeMoveDrag({
  iframeElement,
  styleTarget,
  canvasRootRef,
}: UseCanvasFreeMoveDragOptions) {
  const tryBegin = (event: ReactPointerEvent<HTMLElement>): boolean => {
    if (event.button !== 0 || !styleTarget || !iframeElement) return false

    const state = useEditorStore.getState()
    if (state.selectedNodeIds.length !== 1) return false
    const nodeId = state.selectedNodeIds[0]
    const tree = selectActiveCanvasPage(state)
    const node = tree?.nodes[nodeId]
    if (!node || node.locked) return false

    // Pinned inset edges freeze their axis; both axes pinned means the
    // element cannot move at all, so let the reorder drag take over.
    const lockX =
      state.lockedInsetSides.includes('left') || state.lockedInsetSides.includes('right')
    const lockY =
      state.lockedInsetSides.includes('top') || state.lockedInsetSides.includes('bottom')
    if (lockX && lockY) return false

    const doc = iframeElement.contentDocument
    const win = doc?.defaultView
    if (!doc || !win) return false
    const element = doc.querySelector<HTMLElement>(
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
    const startRight = parsePx(computed.right)
    const startBottom = parsePx(computed.bottom)
    const startX = event.clientX
    const startY = event.clientY

    // The drag rewrites every offset the target actually STORES, so the
    // inspector's inset values all follow the move instead of going stale:
    // a stored `right`/`bottom` gets its mirrored delta, and `left`/`top`
    // are only introduced when their axis has no opposite-edge anchor.
    const stored = styleTarget.styles
    const isOffset = (v: unknown) =>
      v != null && v !== '' && String(v).trim().toLowerCase() !== 'auto'
    const hasRight = isOffset(stored.right)
    const hasBottom = isOffset(stored.bottom)
    const writesLeft = isOffset(stored.left) || !hasRight
    const writesTop = isOffset(stored.top) || !hasBottom

    // ── Snap candidates: siblings + parent box, measured ONCE at drag start.
    // All in iframe CSS px (the iframe document is never transformed).
    const startRect = toRect(element.getBoundingClientRect())
    const candidatesX: SnapCandidate[] = []
    const candidatesY: SnapCandidate[] = []
    const parent = element.parentElement
    if (parent) {
      const parentRect = toRect(parent.getBoundingClientRect())
      candidatesX.push(...axisCandidates(parentRect, 'x'))
      candidatesY.push(...axisCandidates(parentRect, 'y'))
      let counted = 0
      for (const sibling of parent.children) {
        if (sibling === element) continue
        if (counted >= MAX_SNAP_SIBLINGS) break
        const rect = sibling.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        counted++
        const r = toRect(rect)
        candidatesX.push(...axisCandidates(r, 'x'))
        candidatesY.push(...axisCandidates(r, 'y'))
      }
    }
    const snapThreshold = SNAP_THRESHOLD_PX / scale

    const guides = createGuideLines(canvasRootRef?.current ?? null)

    // ── Level-0 preview: inline style writes only; ONE commit on release.
    const touchedProps = [
      ...(writesLeft ? ['left'] : []),
      ...(hasRight ? ['right'] : []),
      ...(writesTop ? ['top'] : []),
      ...(hasBottom ? ['bottom'] : []),
    ]
    const savedInline = saveInline(element, touchedProps)

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some test envs reject setPointerCapture; the iframe relay still works.
    }
    markCanvasPointerRelay(event.pointerId)

    let last: { left?: string; top?: string; right?: string; bottom?: string } = {}
    // Throttled session-channel echo so the inspector's numbers follow the
    // drag live (the document commit still lands once, on release).
    let lastPanelSync = 0

    /** Translate an iframe-space guide segment into canvas-root coords. */
    const drawGuides = (
      snapX: SnapHit | null,
      snapY: SnapHit | null,
      movedRect: Rect,
    ) => {
      const canvasRoot = canvasRootRef?.current
      if (!canvasRoot) return
      const iframeRect = iframeElement.getBoundingClientRect()
      const rootRect = canvasRoot.getBoundingClientRect()
      const originLeft = rootRect.left - canvasRoot.scrollLeft
      const originTop = rootRect.top - canvasRoot.scrollTop
      const mapX = (x: number) => iframeRect.left + x * scale - originLeft
      const mapY = (y: number) => iframeRect.top + y * scale - originTop
      if (snapX) {
        const y1 = Math.min(movedRect.top, snapX.rect.top)
        const y2 = Math.max(movedRect.top + movedRect.height, snapX.rect.top + snapX.rect.height)
        guides.showV(mapX(snapX.coord), mapY(y1), mapY(y2))
      } else {
        guides.hideV()
      }
      if (snapY) {
        const x1 = Math.min(movedRect.left, snapY.rect.left)
        const x2 = Math.max(movedRect.left + movedRect.width, snapY.rect.left + snapY.rect.width)
        guides.showH(mapY(snapY.coord), mapX(x1), mapX(x2))
      } else {
        guides.hideH()
      }
    }

    const teardown = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleCancelEvent)
      window.removeEventListener('keydown', handleKey, true)
      clearCanvasPointerRelay()
      guides.destroy()
    }

    const handleMove = (move: PointerEvent) => {
      move.preventDefault()
      let dx = lockX ? 0 : (move.clientX - startX) / scale
      let dy = lockY ? 0 : (move.clientY - startY) / scale

      const snapX = lockX
        ? null
        : bestSnap(startRect.left + dx, startRect.width, candidatesX, snapThreshold)
      const snapY = lockY
        ? null
        : bestSnap(startRect.top + dy, startRect.height, candidatesY, snapThreshold)
      if (snapX) dx += snapX.adjust
      if (snapY) dy += snapY.adjust

      last = {
        ...(lockX
          ? {}
          : {
              ...(writesLeft ? { left: `${Math.round(startLeft + dx)}px` } : {}),
              ...(hasRight ? { right: `${Math.round(startRight - dx)}px` } : {}),
            }),
        ...(lockY
          ? {}
          : {
              ...(writesTop ? { top: `${Math.round(startTop + dy)}px` } : {}),
              ...(hasBottom ? { bottom: `${Math.round(startBottom - dy)}px` } : {}),
            }),
      }
      for (const [prop, value] of Object.entries(last)) {
        element.style.setProperty(prop, value)
      }

      const now = performance.now()
      if (now - lastPanelSync >= 64) {
        lastPanelSync = now
        useEditorStore.getState().setCanvasGesturePreview(last)
      }

      drawGuides(snapX, snapY, {
        left: startRect.left + dx,
        top: startRect.top + dy,
        width: startRect.width,
        height: startRect.height,
      })
    }
    const handleEnd = () => {
      teardown()
      useEditorStore.getState().setCanvasGesturePreview(null)
      if (Object.keys(last).length === 0) {
        restoreInline(element, savedInline)
        return
      }
      styleTarget.writeStyles(last)
      // An inline-target commit lands in the SAME style attribute the preview
      // wrote — restoring the pre-drag values would wipe the commit (React's
      // style-prop diff never re-applies values it believes are already set).
      // Only a class-rule commit rolls the preview back, held two frames so
      // the injected CSS lands first — no flash of the pre-drag position.
      if (styleTarget.kind !== 'inline') {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => restoreInline(element, savedInline)),
        )
      }
    }
    const handleCancelEvent = () => {
      teardown()
      useEditorStore.getState().setCanvasGesturePreview(null)
      restoreInline(element, savedInline)
    }
    const handleKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.stopPropagation()
      handleCancelEvent()
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleCancelEvent)
    window.addEventListener('keydown', handleKey, true)
    return true
  }

  return { tryBegin }
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}
