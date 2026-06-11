/**
 * CanvasLiveSurface — the single real-size editable frame shown when
 * canvasView is 'live'.
 *
 * This replaces the design canvas's pan/zoom multi-breakpoint layer with ONE
 * frame at 100% size, scrolling normally — like a conventional visual editor's
 * live view. Crucially it is NOT a read-only preview: it reuses the very same
 * editable iframe (`IframeFrameSurface`) and selection overlay the design
 * canvas uses, so click-to-select, the properties panel, and structural edits
 * all keep working here. The only differences from a design frame are layout
 * (single, real-size, internally scrolling) and the absence of pan/zoom.
 *
 * Width model ("fluid + presets"):
 * - The frame fills the available surface width by default (fluid).
 * - Picking a narrower breakpoint in the toggle clamps the frame to that
 *   breakpoint's width, centred, to test responsiveness. `computeNaturalWidth`
 *   resolves this as `min(breakpoint.width, containerWidth)`.
 * - Side handles let the author fine-tune the width continuously between the
 *   minimum and the breakpoint's natural width.
 *
 * Runtime scripts: when the "Run scripts" toggle is on, CanvasRoot passes the
 * bundled scripts down via `runtimeScripts`; they execute inside this frame
 * just as they do in the design frames.
 *
 * Loading: while the page / breakpoints are still hydrating, the surface
 * renders the shared `CanvasFrameSkeleton` inside the live frame's width
 * model — the same treatment the design canvas's `CanvasTransformLayer`
 * gives a null page, so both views load consistently.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Breakpoint, Page } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { CanvasComposedTree } from './CanvasComposedTree'
import { BreakpointSelectionOverlay } from './BreakpointSelectionOverlay'
import { CanvasBreakpointContext, CanvasTemplateContext } from './CanvasContexts'
import { IframeFrameSurface, type IframeFrameSurfaceHandle } from './IframeFrameSurface'
import type { InjectableRuntimeScript } from './useRuntimeScriptBuild'
import { CanvasFrameSkeleton } from '@admin/shared/CanvasFrameSkeleton'
import styles from './CanvasLiveSurface.module.css'

/**
 * The user-resize override is scoped to a specific breakpoint id. Switching
 * breakpoints invalidates a previous override automatically (the derivation
 * just ignores it), so the frame snaps back to the new breakpoint's natural
 * width without a useEffect.
 */
interface LiveWidthOverride {
  breakpointId: string
  width: number
}

interface CanvasLiveSurfaceProps {
  page: Page | null
  activeBreakpoint: Breakpoint | null
  templateContext?: TemplateRenderDataContext
  runtimeScripts?: InjectableRuntimeScript[]
}

/** Hard floor on the frame width so it can't be shrunk into nothing. */
const LIVE_MIN_WIDTH = 240

/** One pixel of pointer travel changes the visible width by 2 (symmetric). */
const SYMMETRIC_DRAG_FACTOR = 2

interface ResizeDragState {
  startClientX: number
  startWidth: number
  side: 'left' | 'right'
}

export function CanvasLiveSurface({
  page,
  activeBreakpoint,
  templateContext,
  runtimeScripts,
}: CanvasLiveSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ResizeDragState | null>(null)

  // Outer viewport `<div>` wrapping the iframe — the selection overlay measures
  // it for positioning context, and queries the iframe element for node rects.
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null)

  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const [widthOverride, setWidthOverride] = useState<LiveWidthOverride | null>(null)

  useEffect(() => {
    const node = surfaceRef.current
    if (!node) return
    const update = () => setContainerWidth(node.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const naturalWidth = computeNaturalWidth(activeBreakpoint, containerWidth)
  const effectiveMaxWidth = naturalWidth ?? containerWidth ?? null
  const effectiveWidth =
    activeBreakpoint && widthOverride?.breakpointId === activeBreakpoint.id
      ? widthOverride.width
      : naturalWidth

  // useCallback kept: react-hooks/refs escape hatch — dragRef.current is read/
  // written in event handlers; a plain render-scoped function trips the
  // "ref access during render" lint rule.
  const handlePointerDown = useCallback(
    (side: 'left' | 'right') => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (effectiveWidth === null || !activeBreakpoint) return
      dragRef.current = { startClientX: event.clientX, startWidth: effectiveWidth, side }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    [effectiveWidth, activeBreakpoint],
  )

  // useCallback kept: react-hooks/refs escape hatch (see handlePointerDown).
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || !activeBreakpoint) return
      const max = effectiveMaxWidth ?? drag.startWidth
      setWidthOverride({
        breakpointId: activeBreakpoint.id,
        width: computeResizedWidth(drag, event.clientX, max),
      })
    },
    [effectiveMaxWidth, activeBreakpoint],
  )

  // useCallback kept: react-hooks/refs escape hatch (see handlePointerDown).
  const finishDrag = useCallback(() => {
    dragRef.current = null
  }, [])

  const handleIframeRef = (handle: IframeFrameSurfaceHandle | null) => {
    setIframeEl(handle?.iframeElement ?? null)
  }

  return (
    <div ref={surfaceRef} className={styles.surface} data-testid="canvas-live-surface">
      {page && activeBreakpoint && effectiveWidth !== null ? (
        <div
          className={styles.frame}
          style={{ '--live-width': `${effectiveWidth}px` } as CSSProperties}
        >
          <LiveResizeHandle
            side="left"
            onPointerDown={handlePointerDown('left')}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />

          <div
            ref={viewportRef}
            data-breakpoint-id={activeBreakpoint.id}
            className={styles.iframeViewport}
          >
            <IframeFrameSurface
              ref={handleIframeRef}
              interaction="live"
              breakpointId={activeBreakpoint.id}
              width={activeBreakpoint.width}
              runtimeScripts={runtimeScripts}
            >
              <CanvasTemplateContext.Provider value={templateContext}>
                <CanvasBreakpointContext.Provider value={activeBreakpoint.id}>
                  <CanvasComposedTree page={page} />
                </CanvasBreakpointContext.Provider>
              </CanvasTemplateContext.Provider>
            </IframeFrameSurface>

            <BreakpointSelectionOverlay
              breakpointId={activeBreakpoint.id}
              viewportRef={viewportRef}
              iframeElement={iframeEl}
            />
          </div>

          <LiveResizeHandle
            side="right"
            onPointerDown={handlePointerDown('right')}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
          />

          <div className={styles.widthBadge} aria-hidden="true">
            {Math.round(effectiveWidth)}px
          </div>
        </div>
      ) : (
        // Same loading treatment as the design canvas: while the page (or the
        // site's breakpoints) are still hydrating, show the shared frame
        // skeleton in the live frame's own width model instead of a misleading
        // empty state. CanvasTransformLayer does the equivalent per breakpoint.
        <div
          className={styles.frame}
          style={{
            '--live-width': effectiveWidth !== null ? `${effectiveWidth}px` : '100%',
          } as CSSProperties}
          data-testid="canvas-live-loading-frame"
        >
          <div className={styles.iframeViewport}>
            <CanvasFrameSkeleton breakpointId={activeBreakpoint?.id ?? 'live'} />
          </div>
        </div>
      )}
    </div>
  )
}

function computeNaturalWidth(breakpoint: Breakpoint | null, containerWidth: number | null): number | null {
  if (!breakpoint) return null
  if (containerWidth === null) return breakpoint.width
  return Math.min(breakpoint.width, containerWidth)
}

function computeResizedWidth(drag: ResizeDragState, clientX: number, max: number): number {
  const delta = clientX - drag.startClientX
  const widthDelta = drag.side === 'left' ? -delta * SYMMETRIC_DRAG_FACTOR : delta * SYMMETRIC_DRAG_FACTOR
  const next = drag.startWidth + widthDelta
  return Math.max(LIVE_MIN_WIDTH, Math.min(max, next))
}

interface LiveResizeHandleProps {
  side: 'left' | 'right'
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
}

function LiveResizeHandle({
  side,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: LiveResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize live frame from ${side}`}
      data-side={side}
      data-testid={`canvas-live-resize-${side}`}
      className={styles.resizeHandle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <span className={styles.resizeGrip} aria-hidden="true" />
    </div>
  )
}
