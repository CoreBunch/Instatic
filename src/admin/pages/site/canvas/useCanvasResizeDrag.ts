/**
 * useCanvasResizeDrag — drag one of the eight selection handles to resize
 * the selected element on the canvas.
 *
 * Gesture model (preview/commit split):
 *   - While the pointer moves, the new size previews by writing the
 *     element's INLINE style inside the iframe — no store commit, no CRDT
 *     op, no React re-render per move. The selection ring tracks it for
 *     free (the overlay RAF loop re-measures every frame).
 *   - On release the inline preview is held for two frames while ONE
 *     commit flows through the active style target (class rule, breakpoint
 *     override, or inline styles — same channel as the Properties panel),
 *     then the preview props are restored so the committed CSS takes over
 *     without a flash of the pre-drag size.
 *   - Escape mid-drag restores the pre-drag inline style and commits
 *     nothing.
 *
 * Axis semantics: E/W handles write `width`, N/S write `height`, corners
 * write both. On a positioned element (relative / absolute / fixed) the W
 * and N handles also shift `left` / `top` so the grabbed edge follows the
 * pointer while the opposite edge stays put; on a static element they
 * resize from the opposite edge (the element stays in flow).
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { getActiveStyleTab, type ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import type { CSSPropertyBag } from '@core/page-tree'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'
import type { ResizeHandleDirection } from './canvasSelectionOverlayPositioning'

const POSITIONED = new Set(['relative', 'absolute', 'fixed'])
const MIN_SIZE_PX = 4

interface UseCanvasResizeDragOptions {
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
}

/** Inline props the preview touches, with their pre-drag values. */
export type SavedInline = Array<{ prop: string; value: string; priority: string }>

export function saveInline(el: HTMLElement, props: string[]): SavedInline {
  return props.map((prop) => ({
    prop,
    value: el.style.getPropertyValue(prop),
    priority: el.style.getPropertyPriority(prop),
  }))
}

export function restoreInline(el: HTMLElement, saved: SavedInline): void {
  for (const { prop, value, priority } of saved) {
    if (value) el.style.setProperty(prop, value, priority)
    else el.style.removeProperty(prop)
  }
}

export function useCanvasResizeDrag({
  iframeElement,
  styleTarget,
}: UseCanvasResizeDragOptions) {
  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    direction: ResizeHandleDirection,
  ): void => {
    if (event.button !== 0 || !iframeElement) return

    const state = useEditorStore.getState()
    if (state.selectedNodeIds.length !== 1) return
    const nodeId = state.selectedNodeIds[0]
    const tree = selectActiveCanvasPage(state)
    const node = tree?.nodes[nodeId]
    if (!node || node.locked) return

    // No writable style target on a non-base context means the commit could
    // only land in the node's BASE inline styles — changing every breakpoint,
    // not just the one being edited. Refuse the gesture and say why instead
    // of leaking the write (author decision 2026-08-31: block + hint).
    if (!styleTarget) {
      const conditionActive =
        state.activeConditionId !== null &&
        (state.site?.conditions?.some((c) => c.id === state.activeConditionId) ?? false)
      if (getActiveStyleTab(state.activeBreakpointId) !== 'base' || conditionActive) {
        pushToast({
          kind: 'info',
          title: 'Inline styles apply at every breakpoint',
          body: 'Add a class to this element to resize it per breakpoint.',
        })
        return
      }
    }

    const doc = iframeElement.contentDocument
    const win = doc?.defaultView
    if (!doc || !win) return
    const element = doc.querySelector<HTMLElement>(
      `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`,
    )
    if (!element) return

    event.preventDefault()
    event.stopPropagation()

    const computed = win.getComputedStyle(element)
    const positioned = POSITIONED.has(computed.position)

    const affectsX = direction.includes('e') || direction.includes('w')
    const affectsY = direction.includes('n') || direction.includes('s')
    // W/N grow leftward/upward: the delta flips, and on positioned elements
    // the same delta shifts left/top so the grabbed edge follows the pointer.
    const signX = direction.includes('w') ? -1 : 1
    const signY = direction.includes('n') ? -1 : 1
    const shiftsLeft = positioned && direction.includes('w')
    const shiftsTop = positioned && direction.includes('n')

    // Computed width/height are used values in px, already expressed against
    // the element's own box-sizing — writing them back is size-preserving.
    const startW = parsePx(computed.width)
    const startH = parsePx(computed.height)
    const startLeft = parsePx(computed.left)
    const startTop = parsePx(computed.top)
    const startX = event.clientX
    const startY = event.clientY

    const scale =
      iframeElement.offsetWidth > 0
        ? iframeElement.getBoundingClientRect().width / iframeElement.offsetWidth
        : 1

    const touchedProps = [
      ...(affectsX ? ['width'] : []),
      ...(affectsY ? ['height'] : []),
      ...(shiftsLeft ? ['left'] : []),
      ...(shiftsTop ? ['top'] : []),
    ]
    const savedInline = saveInline(element, touchedProps)

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some test envs reject setPointerCapture; the iframe relay still works.
    }
    markCanvasPointerRelay(event.pointerId)

    let last: Partial<CSSPropertyBag> = {}
    // Throttled session-channel echo — inspector Size/inset fields follow
    // the handle live; the document commit still lands once, on release.
    let lastPanelSync = 0

    const applyPreview = (dxScreen: number, dyScreen: number) => {
      const dx = (dxScreen / scale) * signX
      const dy = (dyScreen / scale) * signY
      const patch: Partial<CSSPropertyBag> = {}
      if (affectsX) {
        const w = Math.round(Math.max(MIN_SIZE_PX, startW + dx))
        patch.width = `${w}px`
        if (shiftsLeft) patch.left = `${Math.round(startLeft + (startW - w))}px`
      }
      if (affectsY) {
        const h = Math.round(Math.max(MIN_SIZE_PX, startH + dy))
        patch.height = `${h}px`
        if (shiftsTop) patch.top = `${Math.round(startTop + (startH - h))}px`
      }
      for (const [prop, value] of Object.entries(patch)) {
        element.style.setProperty(kebab(prop), String(value))
      }
      last = patch

      const now = performance.now()
      if (now - lastPanelSync >= 64) {
        lastPanelSync = now
        useEditorStore.getState().setCanvasGesturePreview(patch)
      }
    }

    const teardown = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleCancel)
      window.removeEventListener('keydown', handleKey, true)
      clearCanvasPointerRelay()
    }

    const handleMove = (move: PointerEvent) => {
      move.preventDefault()
      applyPreview(move.clientX - startX, move.clientY - startY)
    }
    const handleEnd = () => {
      teardown()
      useEditorStore.getState().setCanvasGesturePreview(null)
      if (Object.keys(last).length === 0) {
        restoreInline(element, savedInline)
        return
      }
      // With no active style target (no active class, not inline-editing) the
      // resize still has to land somewhere — the node's inline styles are the
      // honest default, same place a fresh element's first styles go.
      if (styleTarget) styleTarget.writeStyles(last)
      else useEditorStore.getState().setNodeInlineStyles(nodeId, last)
      // An inline-target commit lands in the SAME style attribute the preview
      // wrote — the preview already IS the committed state, and restoring the
      // pre-drag values would wipe the commit (React's style-prop diff never
      // re-applies values it believes are already set). Only a class-rule
      // commit rolls the preview back, held two frames so the injected CSS
      // lands first — no flash of the pre-drag size.
      if (styleTarget && styleTarget.kind !== 'inline') {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => restoreInline(element, savedInline)),
        )
      }
    }
    const handleCancel = () => {
      teardown()
      useEditorStore.getState().setCanvasGesturePreview(null)
      restoreInline(element, savedInline)
    }
    const handleKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return
      key.stopPropagation()
      handleCancel()
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleCancel)
    window.addEventListener('keydown', handleKey, true)
  }

  return { begin }
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}
