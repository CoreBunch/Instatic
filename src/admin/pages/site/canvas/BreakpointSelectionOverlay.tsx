/**
 * BreakpointSelectionOverlay — selection and hover rings for the canvas.
 *
 * Why this exists
 * ───────────────
 * The previous design rendered selection/hover rings via a `::after`
 * pseudo-element on `NodeWrapper`. That required `NodeWrapper` to produce a
 * layout box (`<div>` with `position: relative`), which in turn forced every
 * canvas node into block flow — breaking inline behaviour (two `<a>` siblings
 * stacking instead of sitting side-by-side, flex-row containers laying out as
 * column, etc.) and diverging from the published HTML.
 *
 * Now `NodeWrapper` is `display: contents` (no layout box, exact match for
 * published), and rings live here as absolutely-positioned divs over the
 * actual rendered module element.
 *
 * Architecture
 * ────────────
 * - One overlay per breakpoint frame. Drop indicators stay inside the
 *   breakpoint viewport (they only appear during a drag, and the
 *   transform-scaled coordinate path is established for them).
 * - Selection / hover rings AND the selection toolbar are portaled into
 *   the canvas root — i.e. they live OUTSIDE `CanvasTransformLayer` and
 *   are therefore NOT scaled by the canvas zoom. The 1px border (set via
 *   `box-shadow: inset 0 0 0 1px …`) stays a real pixel at every zoom
 *   level, which is critical for the user to see what they have selected
 *   when zoomed out. Position alone tracks the (scaled) element, matching
 *   the existing toolbar pattern.
 * - Subscribes to `selectedNodeId` and (per-frame) `hoveredNodeId`.
 * - Resolves the rendered element via `[data-node-id="X"]` directly — each
 *   module spreads `nodeWrapperProps` onto its own root tag, so the matched
 *   element IS the rendered `<article>` / `<h1>` / grid `<div>` / etc., and
 *   its rect spans the whole element (including every grid column or flex
 *   child). Reading the rect off a `firstElementChild` was a leftover from
 *   the old `<div class="nodeWrapper">` design and produced a selection ring
 *   the size of the first child only.
 * - Computes the rect relative to the canvas root on every animation frame
 *   while a ring is visible (cheap; getBoundingClientRect + style write).
 *   Polling via RAF is simpler than wiring ResizeObserver/MutationObserver/
 *   IntersectionObserver to every possible mutation source.
 * - Clears style positioning when the tracked node disappears or the
 *   selection/hover clears.
 * - Renders the selected-layer toolbar AND the selection / hover rings
 *   through a portal into the canvas root so they escape the breakpoint
 *   viewport's overflow boundary and the transform layer's scale, but stay
 *   inside the canvas's stacking + clipping context. That way the editor
 *   sidebars (z-index 55), dialogs (95+), modals (200+) and overlays
 *   naturally paint above them — instead of being covered by a
 *   max-z-index fixed-position toolbar floating over the whole document.
 *   Falls back to document.body with position:fixed when the canvas root
 *   isn't available (tests, transient mount race).
 *
 * Contract
 * ────────
 * The ring and indicator overlay is presentational and click-through
 * (`pointer-events: none` in CSS). The selected-layer toolbar is interactive
 * and clipped by the canvas root.
 */

import { use, useEffect, useEffectEvent, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { styleRuleSelector } from '@core/page-tree'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { CopyPlusSolidIcon } from 'pixel-art-icons/icons/copy-plus-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { HandGrabSolidIcon } from 'pixel-art-icons/icons/hand-grab-solid'
import { CanvasViewportActionsContext } from './CanvasContexts'
import { CanvasInsertModuleButton } from './CanvasInsertModuleButton'
import { useCanvasReorderDrag } from './useCanvasReorderDrag'
import { measureCanvasNodeClientUnionRect } from './canvasDomGeometry'
import { useCanvasTreeLadderOverlay } from './CanvasTreeLadderOverlay'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { measureCanvasElementRect } from './canvasOverlayGeometry'
import type {
  CanvasDropAxis,
  CanvasDropTarget,
  CanvasRect,
} from './canvasDnd'
import styles from './BreakpointSelectionOverlay.module.css'

const TOOLBAR_VERTICAL_OFFSET = 30

interface BreakpointSelectionOverlayProps {
  /**
   * The breakpoint frame this overlay belongs to. Used to scope the hover
   * ring — only the frame that owns the current hover renders one. Selection
   * applies to all frames simultaneously (the user sees the same node
   * highlighted in every breakpoint preview).
   */
  breakpointId: string
  /**
   * Ref to the outer viewport `<div>` (which contains the iframe). Used for
   * zoom recovery (`offsetWidth` vs `getBoundingClientRect().width`), the
   * toolbar's canvas-root container, and reorder-drag drop-candidate
   * measurement against the wrapping layout box.
   */
  viewportRef: React.RefObject<HTMLElement | null>
  /**
   * The iframe element that hosts this breakpoint's page tree. The overlay
   * queries `iframeElement.contentDocument` for `[data-node-id]` targets,
   * gets their inside-iframe rects, then translates to editor-document
   * coordinates using the iframe's own client rect. `null` until the iframe
   * mounts.
   */
  iframeElement: HTMLIFrameElement | null
}

function duplicateSelectedLayers() {
  const ids = useEditorStore.getState().selectedNodeIds
  if (ids.length === 0) return
  useEditorStore.getState().duplicateNodes(ids)
}

function deleteSelectedLayers() {
  const ids = useEditorStore.getState().selectedNodeIds
  if (ids.length === 0) return
  const state = useEditorStore.getState()
  state.deleteNodes(ids)
  state.clearSelection()
}

export function BreakpointSelectionOverlay({
  breakpointId,
  viewportRef,
  iframeElement,
}: BreakpointSelectionOverlayProps) {
  // Multi-select: render one ring per selected node. `useShallow` keeps the
  // subscription stable when the array reference changes but its contents
  // are equal (matters because selectedNodeIds is a new array every set call).
  const selectedNodeIds = useEditorStore(useShallow((s) => s.selectedNodeIds))
  // `hoveredBreakpointId === null` means "global hover" — i.e. the hover did
  // not originate from a specific breakpoint frame on the canvas (e.g. it was
  // triggered by hovering a row in the DOM panel). In that case every frame
  // mirrors the hover so the user sees the highlight wherever they're looking.
  // When the hover originated from the canvas itself, scope it to the owning
  // frame so adjacent breakpoint previews don't all light up at once.
  const hoveredNodeId = useEditorStore((s) =>
    s.hoveredNodeId &&
    (s.hoveredBreakpointId === null || s.hoveredBreakpointId === breakpointId)
      ? s.hoveredNodeId
      : null,
  )
  const hoveredBreakpointOrigin = useEditorStore((s) => s.hoveredBreakpointId)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)

  // Selector-affinity highlight: the CSS selector of the rule currently hovered
  // in the Selectors panel, or null. Resolved to its selector string here so the
  // RAF tick can `querySelectorAll` it inside the iframe and ring every match.
  // Like the DOM-panel hover, this is a global highlight — every breakpoint
  // frame mirrors it, so the user sees the affinity wherever they're looking.
  const highlightedSelector = useEditorStore((s) => {
    const classId = s.highlightedSelectorClassId
    if (!classId) return null
    const rule = s.site?.styleRules[classId]
    return rule ? styleRuleSelector(rule) : null
  })
  // One ref per selected node, keyed by id. Stable across renders while the
  // id stays in the selection — when an id is removed, its ring entry is
  // dropped from the map; when added, a fresh ref is allocated.
  const ringRefs = useRef<Map<string, HTMLDivElement | null> | null>(null)
  if (ringRefs.current === null) ringRefs.current = new Map()
  const hoverRef = useRef<HTMLDivElement>(null)
  // Container whose children are the orange selector-affinity rings. Their
  // count is driven by the live DOM (how many elements match the selector), so
  // they're created/positioned imperatively in the RAF tick rather than mapped
  // from React state — there's no node-id list to map over.
  const selectorHighlightRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const viewportActions = use(CanvasViewportActionsContext)

  // Selection toolbar (drag / duplicate / delete) is purely structural —
  // hidden for callers without `site.structure.edit`. Content-only Clients
  // still get the selection ring (they click to select for content edit),
  // but no action chrome.
  //
  // Pure Viewers (no edit caps at all) see neither rings nor toolbar — the
  // canvas is a read-only inspection surface for them; selection ribbons
  // would just be visual clutter with no follow-on action available.
  const permissions = useEditorPermissions()
  const anyEditCap =
    permissions.canEditStructure || permissions.canEditContent || permissions.canEditStyle
  const showRings = anyEditCap
  const showSelectorHighlight = showRings && Boolean(highlightedSelector)
  const showToolbar =
    permissions.canEditStructure &&
    selectedNodeIds.length > 0 &&
    activeBreakpointId === breakpointId

  // Prefer the canvas root as the portal target so overlay chrome sits inside
  // the canvas's stacking + clipping context. Fall back to document.body for
  // tests or transient mount races where the ref isn't ready yet.
  const canvasRoot = viewportActions?.canvasRootRef.current ?? null
  const portalTarget = canvasRoot ?? document.body
  const toolbarMode = canvasRoot ? 'scoped' : 'fixed'
  const treeLadder = useCanvasTreeLadderOverlay({
    breakpointId,
    iframeElement,
    canvasRoot,
    portalTarget,
    portalMode: toolbarMode,
    show: showRings,
    hoveredNodeId,
    hoveredBreakpointOrigin,
  })
  // Hover only renders when the hovered node isn't already part of the
  // selection — otherwise the two rings would stack and the hover ring
  // would mask the selection ring. In Alt/Option inspect mode, the ladder
  // highlight becomes the hover ring target so keyboard navigation is visible.
  const hoverRingNodeId = treeLadder.hoverNodeId ?? hoveredNodeId
  const showHover = Boolean(hoverRingNodeId) && !selectedNodeIds.includes(hoverRingNodeId ?? '')
  const reorderDrag = useCanvasReorderDrag({
    viewportRef,
    iframeElement,
    selectedNodeIds,
    enabled: showToolbar,
    panBy: viewportActions?.panBy,
    canvasRootRef: viewportActions?.canvasRootRef,
  })

  // Each RAF tick reads the freshest selection / hover / toolbar inputs from
  // the latest render closure via useEffectEvent. Because the tick always reads
  // the latest values, the effect only needs to re-arm when the loop should
  // start or stop — gated by `hasOverlayWork` below — not on every change to
  // which specific nodes are tracked.
  //
  // Bridge inputs:
  //  - `viewport` is the outer `<div>` (parent doc). Used for drop-indicator
  //    positioning (which stays viewport-local, transform-scaled) and as the
  //    fallback positioning origin when no canvas root is wired in (tests).
  //  - `iframe` is the breakpoint's iframe element. `[data-node-id]` lookups
  //    happen inside `iframe.contentDocument`, then `positionRing` /
  //    `positionToolbar` translate from iframe-document coordinates into
  //    canvas-root-local (screen-px, NOT scaled) coordinates so the 1px
  //    border on each ring stays exactly 1px at every zoom level.
  //  - `canvasRoot` is the editor canvas surface — the rings and toolbar are
  //    portaled into it (see render output below) and positioned in its
  //    coordinate space, escaping the transform layer's scale.
  const tickOnce = useEffectEvent((viewport: HTMLElement, iframe: HTMLIFrameElement | null) => {
    const canvasRoot = viewportActions?.canvasRootRef.current ?? null
    for (const id of selectedNodeIds) {
      positionRing(ringRefs.current?.get(id) ?? null, id, iframe, canvasRoot)
    }
    positionRing(hoverRef.current, showHover ? hoverRingNodeId : null, iframe, canvasRoot)
    syncSelectorHighlightRings(
      selectorHighlightRef.current,
      showSelectorHighlight ? highlightedSelector : null,
      iframe,
      canvasRoot,
    )
    positionToolbar(
      toolbarRef.current,
      showToolbar ? selectedNodeIds : [],
      viewport,
      iframe,
      canvasRoot,
    )
  })

  // The RAF loop exists to re-position overlay chrome as the tracked element
  // moves (scroll, layout shift, zoom/pan, content animation). When there is
  // nothing to track — no selection rings, no hover ring, no selector-affinity
  // rings, no toolbar — there is no work to do, so the loop must not run.
  // Without this guard every breakpoint frame keeps a permanent 60fps RAF loop
  // alive that ticks idle helpers forever and prevents the main thread from
  // sleeping (N frames → N idle loops). The effect re-arms whenever this flag
  // flips, so the loop starts the moment real overlay work appears.
  const hasOverlayWork =
    showToolbar ||
    showSelectorHighlight ||
    (showRings && (selectedNodeIds.length > 0 || showHover))

  useEffect(() => {
    if (!hasOverlayWork) return
    const viewport = viewportRef.current
    if (!viewport) return

    let frame = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      tickOnce(viewport, iframeElement)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [hasOverlayWork, viewportRef, iframeElement])

  const toolbar = showToolbar ? (
    <div
      ref={toolbarRef}
      role="group"
      aria-label="Selection actions"
      className={styles.selectionToolbar}
      data-canvas-selection-toolbar="true"
      data-canvas-toolbar-mode={toolbarMode}
      data-canvas-dragging={reorderDrag.dragging ? 'true' : undefined}
      // The toolbar is portaled into the canvas root, whose onClick clears the
      // selection on background clicks. Without this guard a toolbar click
      // bubbles up, clears the selection, and unmounts the toolbar mid-action
      // (e.g. the Insert-module action would clear the selection as the canvas
      // reselects the element behind). Same pattern as CanvasNotch.
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="secondary"
        size="xs"
        iconOnly
        aria-label="Drag selected layers"
        tooltip="Drag selected layers"
        className={cn(styles.selectionToolbarButton, styles.dragToolbarButton)}
        onPointerDown={reorderDrag.handlePointerDown}
      >
        <HandGrabSolidIcon size={13} color="var(--editor-text)" />
      </Button>
      <CanvasInsertModuleButton buttonClassName={styles.selectionToolbarButton} />

      <Button
        variant="secondary"
        size="xs"
        iconOnly
        aria-label="Duplicate selected layers"
        tooltip="Duplicate selected layers"
        className={styles.selectionToolbarButton}
        onClick={duplicateSelectedLayers}
      >
        <CopyPlusSolidIcon size={13} color="var(--editor-text)" />
      </Button>
      <Button
        variant="secondary"
        size="xs"
        iconOnly
        tone="danger"
        aria-label="Delete selected layers"
        tooltip="Delete selected layers"
        className={styles.selectionToolbarButton}
        onClick={deleteSelectedLayers}
      >
        <TrashSolidIcon size={13} color="var(--editor-danger-light)" />
      </Button>
    </div>
  ) : null

  // Rings live in the canvas root's coordinate space (screen-px, NOT
  // transform-scaled), so their 1px border stays exactly 1px at every zoom
  // level. Position alone tracks the selected/hovered element — same
  // pattern as the toolbar.
  const rings = showRings && (selectedNodeIds.length > 0 || (showHover && hoverRingNodeId) || showSelectorHighlight) ? (
    <div
      className={styles.ringLayer}
      data-canvas-ring-layer-mode={toolbarMode}
      aria-hidden="true"
    >
      {/* Orange affinity rings — populated imperatively by the RAF tick, one
          per element matching the hovered selector. */}
      {showSelectorHighlight && (
        <div ref={selectorHighlightRef} data-canvas-selector-highlight-layer="true" />
      )}
      {selectedNodeIds.map((id) => (
        <div
          key={id}
          ref={(el) => {
            if (el) ringRefs.current?.set(id, el)
            else ringRefs.current?.delete(id)
          }}
          className={cn(styles.ring, styles.selection)}
          data-canvas-selection-ring="true"
          data-node-id={id}
        />
      ))}
      {showHover && hoverRingNodeId && (
        <div
          ref={hoverRef}
          className={cn(styles.ring, styles.hover)}
          data-canvas-hover-ring="true"
          data-node-id={hoverRingNodeId}
        />
      )}
    </div>
  ) : null

  return (
    <>
      {/* Drop indicators stay inside the breakpoint viewport — they only
          appear transiently during a drag, and the transform-scaled
          coordinate path is established for them via `dropIndicatorStyle`. */}
      <div className={styles.overlayLayer}>
        {reorderDrag.target && (
          <div
            className={styles.dropIndicator}
            data-position={reorderDrag.target.position}
            data-axis={reorderDrag.target.axis}
            style={dropIndicatorStyle(reorderDrag.target)}
            aria-hidden="true"
          />
        )}

        {reorderDrag.invalid && (
          <div
            className={styles.invalidDropIndicator}
            style={rectStyle(reorderDrag.invalid.rect)}
            data-axis={reorderDrag.invalid.axis}
            aria-hidden="true"
          />
        )}
      </div>
      {rings && createPortal(rings, portalTarget)}
      {toolbar && createPortal(toolbar, portalTarget)}
      {treeLadder.portal}
    </>
  )
}

// ---------------------------------------------------------------------------
// Positioning helper
// ---------------------------------------------------------------------------

/**
 * Move/resize a ring div to overlay the rendered element of `nodeId`. Hides
 * the ring (display: none) if the element is not currently mounted — happens
 * transiently during page swaps, breakpoint changes, or when the selection
 * points into a hidden subtree.
 *
 * The ring lives in the canvas root's coordinate space (or document.body's
 * when `canvasRoot` is null — tests / transient mount race), NOT inside the
 * transform-scaled layer. So we want POST-transform, screen-px coordinates:
 * the ring's width/height directly mirror the visual size of the selected
 * element on screen, and its 1px box-shadow stays 1px at every zoom.
 *
 * `getBoundingClientRect()` inside the iframe returns un-transformed coords
 * (the iframe document is its own viewport, never transformed). The iframe
 * ELEMENT in the parent doc IS scaled by the canvas transform layer. So we
 * recover the canvas zoom from the iframe element itself (clientRect.width
 * / offsetWidth) and multiply the inner rect by that scale, then add the
 * iframe's outer offset — the result is in editor-document (post-transform)
 * screen-px coords. Subtracting the canvas-root client rect (or zero, in
 * fixed-position fallback mode) gives the ring's own coordinate space.
 */
function positionRing(
  ring: HTMLDivElement | null,
  nodeId: string | null,
  iframe: HTMLIFrameElement | null,
  canvasRoot: HTMLElement | null,
): void {
  if (!ring) return

  if (!nodeId) {
    ring.style.display = 'none'
    return
  }

  // `[data-node-id]` elements live inside the iframe's document now. Query
  // there. Each module spreads `nodeWrapperProps` directly onto its own root
  // tag (the `<a>` / `<h1>` / grid `<div>` / …), so the matched element IS
  // the rendered element and its `getBoundingClientRect()` spans the full
  // visual extent — every column of a grid, every row of a flex container.
  // Reading the rect off `firstElementChild` was a leftover from when a
  // wrapping `<div class="nodeWrapper">` sat between `data-node-id` and the
  // rendered tag; it produced a selection ring the size of the first child.
  const iframeDoc = iframe?.contentDocument
  if (!iframeDoc) {
    ring.style.display = 'none'
    return
  }
  const target = iframeDoc.querySelector<HTMLElement>(
    `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`,
  )

  const rect = measureCanvasElementRect(target, iframe, canvasRoot)
  if (!rect) {
    ring.style.display = 'none'
    return
  }

  applyOverlayRectStyle(ring, rect)
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
 * Sync the orange affinity rings to the set of elements matching `selector`
 * inside the breakpoint iframe. Reuses a pool of ring divs under `container`:
 * grows it to match the live match count (capped), positions each over its
 * element, and hides any surplus from a previous, larger match set.
 *
 * Passing `selector === null` (or an absent container/iframe) clears the pool.
 */
function syncSelectorHighlightRings(
  container: HTMLDivElement | null,
  selector: string | null,
  iframe: HTMLIFrameElement | null,
  canvasRoot: HTMLElement | null,
): void {
  if (!container) return

  const iframeDoc = iframe?.contentDocument
  if (!selector || !iframeDoc) {
    hideSurplusRings(container, 0)
    return
  }

  // Ambient selectors are arbitrary author/CSS-importer strings; a malformed
  // one makes querySelectorAll throw. Treat that as "matches nothing" rather
  // than letting it bubble out of the RAF loop.
  let matches: NodeListOf<HTMLElement>
  try {
    matches = iframeDoc.querySelectorAll<HTMLElement>(selector)
  } catch {
    hideSurplusRings(container, 0)
    return
  }

  const count = Math.min(matches.length, SELECTOR_HIGHLIGHT_RING_CAP)
  for (let i = 0; i < count; i++) {
    let ring = container.children[i] as HTMLDivElement | undefined
    if (!ring) {
      ring = container.ownerDocument.createElement('div')
      ring.className = cn(styles.ring, styles.selectorHighlight)
      ring.setAttribute('data-canvas-selector-highlight-ring', 'true')
      container.appendChild(ring)
    }
    const rect = measureCanvasElementRect(matches[i], iframe!, canvasRoot)
    if (!rect) {
      ring.style.display = 'none'
      continue
    }
    applyOverlayRectStyle(ring, rect)
  }
  hideSurplusRings(container, count)
}

function applyOverlayRectStyle(
  element: HTMLElement,
  rect: { x: number; y: number; width: number; height: number },
): void {
  Object.assign(element.style, {
    display: '',
    transform: `translate(${rect.x}px, ${rect.y}px)`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

/** Hide every pooled ring from index `keep` onward (they're reused, not removed). */
function hideSurplusRings(container: HTMLDivElement, keep: number): void {
  for (let i = keep; i < container.children.length; i++) {
    ;(container.children[i] as HTMLElement).style.display = 'none'
  }
}

function positionToolbar(
  toolbar: HTMLDivElement | null,
  nodeIds: readonly string[],
  viewport: HTMLElement,
  iframe: HTMLIFrameElement | null,
  canvasRoot: HTMLElement | null,
): void {
  if (!toolbar || nodeIds.length === 0) {
    if (toolbar) toolbar.style.display = 'none'
    return
  }

  // Pass the iframe through so the helper queries the right document AND
  // translates each measured rect from iframe-internal coords into editor
  // coords. Without this the toolbar would anchor to (0,0) of the editor.
  const rect = measureCanvasNodeClientUnionRect(viewport, nodeIds, iframe)
  if (!rect) {
    toolbar.style.display = 'none'
    return
  }

  // When the selected element has been panned/zoomed entirely outside the
  // canvas root's visible area, hide the toolbar rather than leaving it
  // anchored to an off-canvas position. Otherwise the toolbar appears to
  // "hang on screen" detached from the element it belongs to. This also
  // covers the case where overflow:hidden clipping would only partially hide
  // the toolbar — once the element is gone, hide the chrome cleanly.
  if (canvasRoot) {
    const canvasRect = canvasRoot.getBoundingClientRect()
    const elementFullyOutOfBounds =
      rect.right <= canvasRect.left ||
      rect.left >= canvasRect.right ||
      rect.bottom <= canvasRect.top ||
      rect.top >= canvasRect.bottom
    if (elementFullyOutOfBounds) {
      toolbar.style.display = 'none'
      return
    }
  }

  toolbar.style.display = ''

  // Scoped path: toolbar lives inside the canvas root (position: absolute),
  // so the CSS variables are in canvas-root-local coordinates. The canvas
  // root's overflow:hidden then clips the toolbar when it lands outside the
  // visible canvas area (e.g. anchored to an element near a frame edge that
  // the user has panned partly out of view).
  //
  // Fixed path (fallback): toolbar lives in document.body (position: fixed),
  // so the CSS variables remain in viewport (client) coordinates.
  let originLeft = 0
  let originTop = 0
  if (canvasRoot) {
    const canvasRect = canvasRoot.getBoundingClientRect()
    originLeft = canvasRect.left
    originTop = canvasRect.top
  }

  // No horizontal clamping: the toolbar anchors to the selected element's
  // left edge. A previous `Math.max(4, x)` clamp kept the toolbar visible at
  // the canvas-left edge when the element panned off-screen left, but that
  // decoupled the toolbar from the element and left it "hanging" far from
  // the actual selection. The element-out-of-bounds check above already
  // hides the toolbar when the selection is fully off-canvas; for partial
  // overlap, overflow:hidden clips the toolbar so it can't bleed into the
  // sidebars.
  const x = rect.left - originLeft
  const y = rect.top - originTop - TOOLBAR_VERTICAL_OFFSET

  toolbar.style.setProperty('--canvas-toolbar-x', `${x}px`)
  toolbar.style.setProperty('--canvas-toolbar-y', `${y}px`)
}

function dropIndicatorStyle(target: CanvasDropTarget): CSSProperties {
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

function rectStyle(rect: CanvasRect): CSSProperties {
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
