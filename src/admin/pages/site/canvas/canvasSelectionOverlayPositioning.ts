import type { CSSProperties } from 'react'
import { cn } from '@ui/cn'
import type {
  CanvasOverlayMeasureSession,
  CanvasOverlayRect,
} from './canvasOverlayGeometry'
import type {
  CanvasDropAxis,
  CanvasDropTarget,
  CanvasRect,
} from './canvasDnd'
import styles from './BreakpointSelectionOverlay.module.css'

const TOOLBAR_VERTICAL_OFFSET = 30

/**
 * Last placement applied per overlay element ('hidden' or the exact rect).
 * Lets the WRITE phase no-op when nothing moved — same-value style writes
 * are not guaranteed free across engines, and skipping them keeps the
 * steady-state tick read-only.
 */
const appliedOverlayPlacements = new WeakMap<HTMLElement, CanvasOverlayRect | 'hidden'>()

/**
 * Move/resize an overlay div (selection ring, hover ring, affinity ring) to
 * `rect`, in canvas-root scroll-content coordinates (or viewport coordinates
 * in the fixed/body fallback). `rect === null` hides the element — the
 * tracked node is unmounted (page swap, hidden subtree) or the ring is
 * inactive.
 */
export function positionOverlayElement(
  element: HTMLElement | null,
  rect: CanvasOverlayRect | null,
): void {
  if (!element) return
  if (!rect) {
    hideOverlayElement(element)
    return
  }
  const prev = appliedOverlayPlacements.get(element)
  if (
    prev !== undefined &&
    prev !== 'hidden' &&
    prev.x === rect.x &&
    prev.y === rect.y &&
    prev.width === rect.width &&
    prev.height === rect.height
  ) {
    return
  }
  Object.assign(element.style, {
    display: '',
    transform: `translate(${rect.x}px, ${rect.y}px)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
  appliedOverlayPlacements.set(element, rect)
}

export function hideOverlayElement(element: HTMLElement | null): void {
  if (!element) return
  if (appliedOverlayPlacements.get(element) === 'hidden') return
  element.style.display = 'none'
  appliedOverlayPlacements.set(element, 'hidden')
}

/**
 * Hard ceiling on how many affinity rings we draw for one selector. A utility
 * class (e.g. `text-muted`) can match hundreds of elements; measuring every one
 * via `getBoundingClientRect()` on each animation frame would jank the canvas.
 * The match count is already surfaced as the selector's usage badge in the
 * panel, so capping the *rings* (a transient hover affordance) is purely a
 * perf guard, not silent data truncation.
 */
const SELECTOR_HIGHLIGHT_RING_CAP = 300

/**
 * READ-phase half of the selector-affinity highlight: measure every element
 * matching `selector` inside the breakpoint iframe (capped). Returns null
 * when the highlight is inactive (clears the pool in the write phase).
 */
export function measureSelectorHighlightRects(
  selector: string | null,
  iframeDoc: Document,
  session: CanvasOverlayMeasureSession,
): CanvasOverlayRect[] | null {
  if (!selector) return null

  // Ambient selectors are arbitrary author/CSS-importer strings; a malformed
  // one makes querySelectorAll throw. Treat that as "matches nothing" rather
  // than letting it bubble out of the RAF loop.
  let matches: NodeListOf<HTMLElement>
  try {
    matches = iframeDoc.querySelectorAll<HTMLElement>(selector)
  } catch {
    return []
  }

  const count = Math.min(matches.length, SELECTOR_HIGHLIGHT_RING_CAP)
  const rects: CanvasOverlayRect[] = []
  for (let i = 0; i < count; i++) {
    const rect = session.measure(matches[i])
    if (rect) rects.push(rect)
  }
  return rects
}

/**
 * WRITE-phase half: sync the orange affinity ring pool under `container` to
 * the measured `rects` — grows the pool as needed, positions each ring, and
 * hides any surplus from a previous, larger match set (rings are reused, not
 * removed). `rects === null` clears the pool.
 */
export function syncSelectorHighlightRings(
  container: HTMLDivElement | null,
  rects: CanvasOverlayRect[] | null,
): void {
  if (!container) return
  if (!rects) {
    hideSurplusRings(container, 0)
    return
  }

  for (let i = 0; i < rects.length; i++) {
    let ring = container.children[i] as HTMLDivElement | undefined
    if (!ring) {
      ring = container.ownerDocument.createElement('div')
      ring.className = cn(styles.ring, styles.selectorHighlight)
      ring.setAttribute('data-canvas-selector-highlight-ring', 'true')
      container.appendChild(ring)
    }
    positionOverlayElement(ring, rects[i])
  }
  hideSurplusRings(container, rects.length)
}

/** Hide every pooled ring from index `keep` onward (they're reused, not removed). */
export function hideSurplusRings(container: HTMLDivElement, keep: number): void {
  for (let i = keep; i < container.children.length; i++) {
    hideOverlayElement(container.children[i] as HTMLElement)
  }
}

/**
 * Anchor the selection toolbar to `union` — the union of the selection-ring
 * rects already measured this tick (no second query/measure pass). Hides the
 * toolbar when there is no measurable selection or when the selection sits
 * entirely outside the canvas root's visible area — otherwise the toolbar
 * would "hang on screen" detached from the element it belongs to. For
 * partial overlap, the canvas root's overflow:hidden clips it.
 *
 * Scoped path: toolbar lives inside the canvas root (position: absolute), so
 * `left`/`top` are in canvas-root scroll-content coordinates — exactly the
 * coordinate space `union` is measured in. Fixed path (fallback,
 * `canvasRect === null`): toolbar lives in document.body (position: fixed)
 * and the same values are viewport (client) coordinates.
 */
export function positionToolbar(
  toolbar: HTMLDivElement | null,
  union: CanvasOverlayRect | null,
  canvasRect: DOMRect | null,
  scroll: { left: number; top: number },
): void {
  if (!toolbar) return
  if (!union) {
    hideOverlayElement(toolbar)
    return
  }

  if (canvasRect) {
    const visibleLeft = scroll.left
    const visibleRight = scroll.left + canvasRect.width
    const visibleTop = scroll.top
    const visibleBottom = scroll.top + canvasRect.height
    const elementFullyOutOfBounds =
      union.x + union.width <= visibleLeft ||
      union.x >= visibleRight ||
      union.y + union.height <= visibleTop ||
      union.y >= visibleBottom
    if (elementFullyOutOfBounds) {
      hideOverlayElement(toolbar)
      return
    }
  }

  // Keep toolbar actions reachable when a wide selected element overlaps the
  // canvas but its left edge is panned under surrounding editor chrome. Fully
  // out-of-bounds selections are hidden above; clamping here only affects
  // partially visible selections.
  if (canvasRect && toolbar.style.display === 'none') toolbar.style.display = ''
  const rawX = union.x
  let x = rawX
  if (canvasRect) {
    const gutter = 4
    const minX = scroll.left + gutter
    const maxX = Math.max(minX, scroll.left + canvasRect.width - toolbar.offsetWidth - gutter)
    x = Math.min(Math.max(rawX, minX), maxX)
  }

  const placement: CanvasOverlayRect = {
    x,
    y: union.y - TOOLBAR_VERTICAL_OFFSET,
    width: union.width,
    height: union.height,
  }
  const prev = appliedOverlayPlacements.get(toolbar)
  if (prev !== undefined && prev !== 'hidden' && prev.x === placement.x && prev.y === placement.y) {
    return
  }

  toolbar.style.display = ''
  toolbar.style.left = `${placement.x}px`
  toolbar.style.top = `${placement.y}px`
  appliedOverlayPlacements.set(toolbar, placement)
}

/** Order matches the DOM children rendered by BreakpointSelectionOverlay. */
export const RESIZE_HANDLE_DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type ResizeHandleDirection = (typeof RESIZE_HANDLE_DIRECTIONS)[number]

const HANDLE_HALF = 4 // half of the 8px handle, so it centres on the ring edge

/**
 * WRITE-phase placement of the eight resize handles around a selection rect.
 * `container.children[i]` corresponds to RESIZE_HANDLE_DIRECTIONS[i]; each
 * handle is translated so its centre sits on the ring's corner / edge
 * midpoint. `rect === null` hides all handles.
 */
export function positionResizeHandles(
  container: HTMLElement | null,
  rect: CanvasOverlayRect | null,
): void {
  if (!container) return
  if (!rect) {
    for (const child of container.children) hideOverlayElement(child as HTMLElement)
    return
  }
  const xs = { left: rect.x, mid: rect.x + rect.width / 2, right: rect.x + rect.width }
  const ys = { top: rect.y, mid: rect.y + rect.height / 2, bottom: rect.y + rect.height }
  const spots: Record<ResizeHandleDirection, [number, number]> = {
    nw: [xs.left, ys.top],
    n: [xs.mid, ys.top],
    ne: [xs.right, ys.top],
    e: [xs.right, ys.mid],
    se: [xs.right, ys.bottom],
    s: [xs.mid, ys.bottom],
    sw: [xs.left, ys.bottom],
    w: [xs.left, ys.mid],
  }
  RESIZE_HANDLE_DIRECTIONS.forEach((direction, i) => {
    const handle = container.children[i] as HTMLElement | undefined
    if (!handle) return
    const [x, y] = spots[direction]
    positionOverlayElement(handle, { x: x - HANDLE_HALF, y: y - HANDLE_HALF, width: 8, height: 8 })
  })
}

/**
 * WRITE-phase placement of the `W × H` dimension badge: centred under the
 * selection rect, clamped to the canvas root's visible width so it slides
 * inward at the viewport edge instead of being clipped. The label is the
 * element's CSS-px size (overlay px ÷ zoom), so it matches the inspector.
 */
export function positionDimensionBadge(
  badge: HTMLElement | null,
  rect: CanvasOverlayRect | null,
  scale: number,
  canvasRect: DOMRect | null,
  scroll: { left: number; top: number },
): void {
  if (!badge) return
  if (!rect || scale <= 0) {
    hideOverlayElement(badge)
    return
  }
  const label = `${Math.round(rect.width / scale)} × ${Math.round(rect.height / scale)}`
  if (badge.textContent !== label) badge.textContent = label
  if (badge.style.display === 'none') badge.style.display = ''

  let x = rect.x + rect.width / 2
  if (canvasRect) {
    // offsetWidth read lands after the textContent write above, but badge
    // geometry is tiny and this runs once per frame at most — same trade the
    // toolbar clamp makes.
    const half = badge.offsetWidth / 2
    const gutter = 4
    x = Math.min(
      Math.max(x, scroll.left + gutter + half),
      scroll.left + canvasRect.width - gutter - half,
    )
  }
  const placement: CanvasOverlayRect = { x, y: rect.y + rect.height + 6, width: 0, height: 0 }
  const prev = appliedOverlayPlacements.get(badge)
  if (prev !== undefined && prev !== 'hidden' && prev.x === placement.x && prev.y === placement.y) {
    return
  }
  badge.style.transform = `translate(${placement.x}px, ${placement.y}px)`
  appliedOverlayPlacements.set(badge, placement)
}

export function dropIndicatorStyle(target: CanvasDropTarget): CSSProperties {
  if (target.position === 'inside') return rectStyle(target.rect)
  return lineStyle(target.rect, target.position, target.axis)
}

function lineStyle(
  rect: CanvasRect,
  position: 'before' | 'after',
  axis: CanvasDropAxis,
): CSSProperties {
  if (axis === 'horizontal') {
    const x = position === 'before' ? rect.left : rect.right
    return indicatorVars(x, rect.top, 2, rect.height)
  }

  const y = position === 'before' ? rect.top : rect.bottom
  return indicatorVars(rect.left, y, rect.width, 2)
}

export function rectStyle(rect: CanvasRect): CSSProperties {
  return indicatorVars(rect.left, rect.top, rect.width, rect.height)
}

function indicatorVars(x: number, y: number, width: number, height: number): CSSProperties {
  return {
    '--canvas-drop-x': `${x}px`,
    '--canvas-drop-y': `${y}px`,
    '--canvas-drop-w': `${width}px`,
    '--canvas-drop-h': `${height}px`,
  } as CSSProperties
}
