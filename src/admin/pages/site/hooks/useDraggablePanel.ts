/**
 * useDraggablePanel — drag-to-reposition hook for floating editor panels.
 *
 * Features:
 * - Tracks panel position via local React state, persisted to localStorage.
 * - Smooth 60fps drag: imperative CSS-var update during pointermove (no setState),
 *   single setState commit on pointerUp (Guideline #318 — no store writes in pointermove).
 * - Returns a `panelRef` to attach to the panel root element, and `headerDragProps`
 *   to spread onto the draggable header div.
 * - Respects buttons/inputs: drag does not start when clicking an interactive element.
 * - Viewport clamping: panel cannot be dragged entirely off-screen (EDGE_MARGIN guard).
 * - Resize re-clamp: window resize listener keeps panels inside the new viewport bounds.
 *
 * Usage:
 *   const { panelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
 *     'properties',             // ← panelId, NOT a raw localStorage key
 *     () => ({ x: 16, y: 16 }),
 *   )
 *   <div ref={panelRef} style={{ ...panelPositionStyle, '--panel-w': `${width}px` }}>
 *     <div {...headerDragProps} className={styles.header}>…</div>
 *   </div>
 */
import { useState, useRef, useEffect } from 'react'
import {
  readStoredPanelPosition,
  writeStoredPanelPosition,
  type FloatingPanelId,
  type PanelPosition,
} from '@admin/state/workspaceLayoutStorage'

/**
 * Minimum number of pixels that must remain visible on-screen when a panel
 * is dragged towards or past a viewport edge.
 */
const EDGE_MARGIN = 50

interface UseDraggablePanelResult {
  /** Attach to the panel root element so drag can imperatively update CSS vars. */
  panelRef: React.RefObject<HTMLElement | null>
  /** Spread onto the draggable header element. */
  headerDragProps: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void
  }
  /** CSS vars for panel position — spread into panel's style prop. */
  panelPositionStyle: React.CSSProperties
}

interface DragState {
  startClientX: number
  startClientY: number
  startPanelX: number
  startPanelY: number
}

/**
 * Clamp a panel position so at least EDGE_MARGIN pixels remain visible
 * within the current viewport on all four sides.
 */
function clampToViewport(pos: PanelPosition): PanelPosition {
  const maxX = window.innerWidth - EDGE_MARGIN
  const maxY = window.innerHeight - EDGE_MARGIN
  return {
    x: Math.max(-window.innerWidth + EDGE_MARGIN, Math.min(pos.x, maxX)),
    y: Math.max(0, Math.min(pos.y, maxY)),
  }
}

/**
 * @param panelId     Unique panel identifier (e.g. "dom", "properties", "agent", "site").
 * @param getDefault  Called once on mount when no stored position exists.
 *                    Should return a Guideline #410 compliant default position.
 */
export function useDraggablePanel(
  panelId: FloatingPanelId,
  getDefault: () => PanelPosition,
): UseDraggablePanelResult {
  // ── Position state ─────────────────────────────────────────────────────────
  const [position, setPosition] = useState<PanelPosition>(() => {
    return clampToViewport(
      readStoredPanelPosition(panelId)
        ?? getDefault(),
    )
  })

  // Ref-mirrored position: always current, readable in callbacks without stale closure.
  const positionRef = useRef<PanelPosition>(position)
  useEffect(() => {
    positionRef.current = position
  }, [position])

  // Ref to the panel root DOM element (for imperative CSS-var updates during drag).
  const panelRef = useRef<HTMLElement | null>(null)

  // Drag tracking ref — null when not dragging.
  const dragRef = useRef<DragState | null>(null)

  // ── Persist to localStorage when position commits ──────────────────────────
  useEffect(() => {
    writeStoredPanelPosition(panelId, position)
  }, [panelId, position])

  // ── Window resize re-clamp ─────────────────────────────────────────────────
  // When the viewport shrinks, a previously valid position may fall off-screen.
  // Re-clamp stored position so the panel stays reachable after every resize.
  useEffect(() => {
    function onResize() {
      setPosition(prev => clampToViewport(prev))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── Drag handlers ──────────────────────────────────────────────────────────

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Skip drag when clicking interactive elements inside the header
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanelX: positionRef.current.x,
      startPanelY: positionRef.current.y,
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startClientX
    const dy = e.clientY - dragRef.current.startClientY
    const clamped = clampToViewport({
      x: dragRef.current.startPanelX + dx,
      y: dragRef.current.startPanelY + dy,
    })
    // Imperative CSS-var update for 60fps drag — no React setState during move.
    // This avoids triggering React re-renders on every pointermove event.
    const panel = panelRef.current
    if (panel) {
      panel.style.setProperty('--panel-x', `${clamped.x}px`)
      panel.style.setProperty('--panel-y', `${clamped.y}px`)
    }
  }

  function commitDragEnd(clientX: number, clientY: number) {
    if (!dragRef.current) return
    const dx = clientX - dragRef.current.startClientX
    const dy = clientY - dragRef.current.startClientY
    const clamped = clampToViewport({
      x: dragRef.current.startPanelX + dx,
      y: dragRef.current.startPanelY + dy,
    })
    dragRef.current = null
    // Single setState on drag end — triggers React re-render + localStorage persist effect.
    setPosition(clamped)
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    commitDragEnd(e.clientX, e.clientY)
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>) {
    commitDragEnd(e.clientX, e.clientY)
  }

  // ── Panel position style (CSS-var injection — only permitted inline style form) ──
  const panelPositionStyle: React.CSSProperties = {
    '--panel-x': `${position.x}px`,
    '--panel-y': `${position.y}px`,
  } as React.CSSProperties

  return {
    panelRef,
    headerDragProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    panelPositionStyle,
  }
}
