/** Preview the radius drag in the iframe and commit once on release. */
import type { PointerEvent as ReactPointerEvent } from 'react'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
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
  /** Builds the gesture from the resolved element, or null to abort. */
  start: (context: CanvasStyleGestureContext) => CanvasStyleGesture | null
}

export function beginCanvasStyleGesture({
  event,
  iframeElement,
  styleTarget,
  start,
}: BeginCanvasStyleGestureOptions): void {
  if (event.button !== 0 || !iframeElement) return

  const state = useEditorStore.getState()
  if (state.selectedNodeIds.length !== 1) return
  const nodeId = state.selectedNodeIds[0]
  const tree = selectActiveCanvasPage(state)
  const node = tree?.nodes[nodeId]
  if (!node || node.locked) return

  if (!styleTarget) return

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
  }
  const handleEnd = () => {
    teardown()
    if (Object.keys(last).length === 0) {
      restoreInline(element, savedInline)
      return
    }
    styleTarget.writeStyles(last)
    // Only a class-rule commit rolls the preview back, held two frames so the
    // injected CSS lands first — no flash of the pre-drag state.
    if (styleTarget.kind !== 'inline') {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => restoreInline(element, savedInline)),
      )
    }
  }
  const handleCancel = () => {
    teardown()
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
