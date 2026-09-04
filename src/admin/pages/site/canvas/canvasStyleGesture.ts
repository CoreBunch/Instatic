/**
 * canvasStyleGesture — the one preview/commit skeleton behind every drag that
 * edits the selected element's styles from the canvas (resize handles, corner
 * radius handles).
 *
 *   - While the pointer moves, the gesture previews by writing the element's
 *     INLINE style inside the iframe — no store commit, no CRDT op, no React
 *     re-render per move. The selection chrome tracks it for free (the
 *     overlay RAF loop re-measures every frame). A throttled echo lands in
 *     `canvasGesturePreview` so the inspector's fields follow live.
 *   - On release the inline preview is held for two frames while ONE commit
 *     flows through the active style target (class rule, breakpoint
 *     override, or inline styles — same channel as the Properties panel),
 *     then the preview props are restored so the committed CSS takes over
 *     without a flash. An inline-target commit keeps the preview: it lands in
 *     the SAME style attribute, and restoring would wipe it (React's
 *     style-prop diff never re-applies values it believes are already set).
 *   - Escape mid-drag restores the pre-drag inline style and commits nothing.
 *   - No writable style target on a non-base breakpoint / condition means
 *     the commit could only land in the node's BASE inline styles — changing
 *     every breakpoint. The gesture refuses and says why (author decision
 *     2026-08-31: block + hint).
 *
 * A gesture supplies only what differs: which inline props it touches and how
 * a pointer delta (CSS px, zoom already divided out) becomes a style patch.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { pushToast } from '@ui/components/Toast'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { getActiveStyleTab, type ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import type { CSSPropertyBag, PageNode } from '@core/page-tree'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { clearCanvasPointerRelay, markCanvasPointerRelay } from './canvasPointerRelay'

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

export function parsePx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

export interface CanvasStyleGestureContext {
  node: PageNode
  element: HTMLElement
  computed: CSSStyleDeclaration
}

export interface CanvasStyleGesture {
  /** Kebab-case inline props the preview writes — saved before, restored after. */
  touchedProps: string[]
  /**
   * The style patch for a pointer delta in CSS px. A key with an `undefined`
   * value is not previewed inline but IS part of the commit (it clears the
   * property on the style target).
   */
  patchFor: (dx: number, dy: number, move: PointerEvent) => Partial<CSSPropertyBag>
}

interface BeginCanvasStyleGestureOptions {
  event: ReactPointerEvent<HTMLElement>
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
  /** Toast body when the gesture is refused on a non-base context. */
  blockedHint: string
  /** Builds the gesture from the resolved element, or null to abort. */
  start: (context: CanvasStyleGestureContext) => CanvasStyleGesture | null
}

export function beginCanvasStyleGesture({
  event,
  iframeElement,
  styleTarget,
  blockedHint,
  start,
}: BeginCanvasStyleGestureOptions): void {
  if (event.button !== 0 || !iframeElement) return

  const state = useEditorStore.getState()
  if (state.selectedNodeIds.length !== 1) return
  const nodeId = state.selectedNodeIds[0]
  const tree = selectActiveCanvasPage(state)
  const node = tree?.nodes[nodeId]
  if (!node || node.locked) return

  if (!styleTarget) {
    const conditionActive =
      state.activeConditionId !== null &&
      (state.site?.conditions?.some((c) => c.id === state.activeConditionId) ?? false)
    if (getActiveStyleTab(state.activeBreakpointId) !== 'base' || conditionActive) {
      pushToast({
        kind: 'info',
        title: 'Inline styles apply at every breakpoint',
        body: blockedHint,
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

  const gesture = start({ node, element, computed: win.getComputedStyle(element) })
  if (!gesture) return

  const startX = event.clientX
  const startY = event.clientY
  const scale =
    iframeElement.offsetWidth > 0
      ? iframeElement.getBoundingClientRect().width / iframeElement.offsetWidth
      : 1
  const savedInline = saveInline(element, gesture.touchedProps)

  try {
    event.currentTarget.setPointerCapture(event.pointerId)
  } catch {
    // Some test envs reject setPointerCapture; the iframe relay still works.
  }
  markCanvasPointerRelay(event.pointerId)

  let last: Partial<CSSPropertyBag> = {}
  // Throttled session-channel echo — inspector fields follow the handle live;
  // the document commit still lands once, on release.
  let lastPanelSync = 0

  const teardown = () => {
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleEnd)
    window.removeEventListener('pointercancel', handleCancel)
    window.removeEventListener('keydown', handleKey, true)
    clearCanvasPointerRelay()
  }

  const handleMove = (move: PointerEvent) => {
    move.preventDefault()
    const patch = gesture.patchFor(
      (move.clientX - startX) / scale,
      (move.clientY - startY) / scale,
      move,
    )
    for (const [prop, value] of Object.entries(patch)) {
      if (value !== undefined) element.style.setProperty(kebab(prop), String(value))
    }
    last = patch

    const now = performance.now()
    if (now - lastPanelSync >= 64) {
      lastPanelSync = now
      useEditorStore.getState().setCanvasGesturePreview(patch)
    }
  }
  const handleEnd = () => {
    teardown()
    useEditorStore.getState().setCanvasGesturePreview(null)
    if (Object.keys(last).length === 0) {
      restoreInline(element, savedInline)
      return
    }
    // With no active style target (no active class, not inline-editing) the
    // change still has to land somewhere — the node's inline styles are the
    // honest default, same place a fresh element's first styles go.
    if (styleTarget) styleTarget.writeStyles(last)
    else useEditorStore.getState().setNodeInlineStyles(nodeId, last)
    // Only a class-rule commit rolls the preview back, held two frames so the
    // injected CSS lands first — no flash of the pre-drag state.
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
