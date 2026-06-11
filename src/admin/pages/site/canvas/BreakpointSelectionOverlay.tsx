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
 *   while a ring is visible. Polling via RAF is simpler than wiring
 *   ResizeObserver/MutationObserver/IntersectionObserver to every possible
 *   mutation source (scroll, layout shift, zoom/pan, CSS animation) — but
 *   each tick must stay cheap, so it is structured as:
 *     1. READ phase — one `createCanvasOverlayMeasureSession` snapshots the
 *        iframe + canvas-root geometry shared by every ring, tracked
 *        elements resolve through a `CanvasNodeElementCache` (no per-frame
 *        `querySelector` scans), and every rect is measured up front. The
 *        toolbar anchors to the union of the ring rects already measured —
 *        nothing is queried or measured twice.
 *     2. WRITE phase — styles are applied after all reads, and writes are
 *        skipped when a rect matches what's already applied. Steady-state
 *        frames therefore do a handful of cached-layout reads and zero
 *        writes; no read/write interleaving means no forced reflows while
 *        rects are actually changing.
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
import { useCanvasTreeLadderOverlay } from './CanvasTreeLadderOverlay'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import {
  createCanvasOverlayMeasureSession,
  unionCanvasOverlayRects,
  type CanvasOverlayRect,
} from './canvasOverlayGeometry'
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
   * Ref to the outer viewport `<div>` (which contains the iframe). Used by
   * the reorder drag for drop-candidate measurement against the wrapping
   * layout box.
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
  // nodeId → rendered iframe element, reused across RAF ticks so the
  // steady-state tick never pays a per-frame `querySelector` document scan.
  const nodeElementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeElementCacheRef.current === null) nodeElementCacheRef.current = new CanvasNodeElementCache()
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
  //  - `iframe` is the breakpoint's iframe element. `[data-node-id]` lookups
  //    happen inside `iframe.contentDocument`, then the measure session
  //    translates from iframe-document coordinates into canvas-root-local
  //    (screen-px, NOT scaled) coordinates so the 1px border on each ring
  //    stays exactly 1px at every zoom level.
  //  - `canvasRoot` is the editor canvas surface — the rings and toolbar are
  //    portaled into it (see render output below) and positioned in its
  //    coordinate space, escaping the transform layer's scale. Null in the
  //    fixed/body fallback mode (tests, transient mount race), where overlay
  //    coords stay in viewport (client) space.
  //
  // The tick is split into a READ phase (resolve cached elements, measure
  // every rect through one shared geometry session) and a WRITE phase
  // (apply styles, skipping writes whose rect is already applied) — see the
  // header comment. Reordering measurements/writes here can reintroduce
  // per-frame forced reflows.
  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null) => {
    const canvasRoot = viewportActions?.canvasRootRef.current ?? null
    const iframeDoc = iframe?.contentDocument ?? null
    const elementCache = nodeElementCacheRef.current!

    if (!iframe || !iframeDoc) {
      // Nothing measurable (iframe not mounted yet / reloading) — hide all
      // chrome. Pure writes; they no-op once everything is already hidden.
      for (const id of selectedNodeIds) hideOverlayElement(ringRefs.current?.get(id) ?? null)
      hideOverlayElement(hoverRef.current)
      if (selectorHighlightRef.current) hideSurplusRings(selectorHighlightRef.current, 0)
      hideOverlayElement(toolbarRef.current)
      return
    }

    // ── READ phase ──────────────────────────────────────────────────────
    const session = createCanvasOverlayMeasureSession(iframe, canvasRoot)
    const trackedIds = new Set<string>()

    const ringPlacements: Array<{ ring: HTMLDivElement | null; rect: CanvasOverlayRect | null }> = []
    let toolbarUnion: CanvasOverlayRect | null = null
    for (const id of selectedNodeIds) {
      trackedIds.add(id)
      const rect = session.measure(elementCache.resolve(iframeDoc, id))
      ringPlacements.push({ ring: ringRefs.current?.get(id) ?? null, rect })
      if (showToolbar && rect) toolbarUnion = unionCanvasOverlayRects(toolbarUnion, rect)
    }

    const hoverId = showHover ? hoverRingNodeId : null
    let hoverRect: CanvasOverlayRect | null = null
    if (hoverId) {
      trackedIds.add(hoverId)
      hoverRect = session.measure(elementCache.resolve(iframeDoc, hoverId))
    }
    elementCache.retainOnly(trackedIds)

    const selectorRects = measureSelectorHighlightRects(
      showSelectorHighlight ? highlightedSelector : null,
      iframeDoc,
      session,
    )

    // ── WRITE phase ─────────────────────────────────────────────────────
    for (const { ring, rect } of ringPlacements) positionOverlayElement(ring, rect)
    positionOverlayElement(hoverRef.current, hoverRect)
    syncSelectorHighlightRings(selectorHighlightRef.current, selectorRects)
    positionToolbar(toolbarRef.current, showToolbar ? toolbarUnion : null, session.canvasRect)
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

    let frame = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      tickOnce(iframeElement)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [hasOverlayWork, iframeElement])

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
// Positioning helpers — WRITE phase only. Every rect is measured up front in
// the tick's READ phase; these apply the results, skipping writes that match
// what is already on the element so steady-state frames touch no styles.
// ---------------------------------------------------------------------------

/**
 * Last placement applied per overlay element ('hidden' or the exact rect).
 * Lets the WRITE phase no-op when nothing moved — same-value style writes
 * are not guaranteed free across engines, and skipping them keeps the
 * steady-state tick read-only.
 */
const appliedOverlayPlacements = new WeakMap<HTMLElement, CanvasOverlayRect | 'hidden'>()

/**
 * Move/resize an overlay div (selection ring, hover ring, affinity ring) to
 * `rect`, in canvas-root-local coordinates (or viewport coordinates in the
 * fixed/body fallback). `rect === null` hides the element — the tracked node
 * is unmounted (page swap, hidden subtree) or the ring is inactive.
 */
function positionOverlayElement(element: HTMLElement | null, rect: CanvasOverlayRect | null): void {
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

function hideOverlayElement(element: HTMLElement | null): void {
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
function measureSelectorHighlightRects(
  selector: string | null,
  iframeDoc: Document,
  session: ReturnType<typeof createCanvasOverlayMeasureSession>,
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
function syncSelectorHighlightRings(
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
function hideSurplusRings(container: HTMLDivElement, keep: number): void {
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
 * the CSS variables are in canvas-root-local coordinates — exactly the
 * coordinate space `union` is measured in. Fixed path (fallback,
 * `canvasRect === null`): toolbar lives in document.body (position: fixed)
 * and the same values are viewport (client) coordinates.
 */
function positionToolbar(
  toolbar: HTMLDivElement | null,
  union: CanvasOverlayRect | null,
  canvasRect: DOMRect | null,
): void {
  if (!toolbar) return
  if (!union) {
    hideOverlayElement(toolbar)
    return
  }

  if (canvasRect) {
    const elementFullyOutOfBounds =
      union.x + union.width <= 0 ||
      union.x >= canvasRect.width ||
      union.y + union.height <= 0 ||
      union.y >= canvasRect.height
    if (elementFullyOutOfBounds) {
      hideOverlayElement(toolbar)
      return
    }
  }

  // No horizontal clamping: the toolbar anchors to the selected element's
  // left edge. A previous `Math.max(4, x)` clamp kept the toolbar visible at
  // the canvas-left edge when the element panned off-screen left, but that
  // decoupled the toolbar from the element and left it "hanging" far from
  // the actual selection.
  const placement: CanvasOverlayRect = {
    x: union.x,
    y: union.y - TOOLBAR_VERTICAL_OFFSET,
    width: union.width,
    height: union.height,
  }
  const prev = appliedOverlayPlacements.get(toolbar)
  if (prev !== undefined && prev !== 'hidden' && prev.x === placement.x && prev.y === placement.y) {
    return
  }

  toolbar.style.display = ''
  toolbar.style.setProperty('--canvas-toolbar-x', `${placement.x}px`)
  toolbar.style.setProperty('--canvas-toolbar-y', `${placement.y}px`)
  appliedOverlayPlacements.set(toolbar, placement)
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
