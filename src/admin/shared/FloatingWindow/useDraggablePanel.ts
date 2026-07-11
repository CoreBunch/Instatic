import { useEffect, useRef, useState } from 'react'
import {
  readStoredPanelPosition,
  writeStoredPanelPosition,
  type FloatingPanelId,
  type PanelPosition,
} from '@admin/state/workspaceLayoutStorage'

const EDGE_MARGIN = 50

interface UseDraggablePanelResult {
  panelRef: React.RefObject<HTMLElement | null>
  setPanelRef: (element: HTMLElement | null) => void
  headerDragProps: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void
  }
  panelPositionStyle: React.CSSProperties
}

interface DragState {
  startClientX: number
  startClientY: number
  startPanelX: number
  startPanelY: number
}

interface FloatingPanelBounds {
  viewportWidth: number
  viewportHeight: number
  panelWidth: number
}

/** Keep at least one 50px drag-handle strip reachable on every edge. */
export function clampFloatingPanelPosition(
  position: PanelPosition,
  bounds: FloatingPanelBounds,
): PanelPosition {
  const maxX = bounds.viewportWidth - EDGE_MARGIN
  const maxY = bounds.viewportHeight - EDGE_MARGIN
  return {
    x: Math.max(EDGE_MARGIN - bounds.panelWidth, Math.min(position.x, maxX)),
    y: Math.max(0, Math.min(position.y, maxY)),
  }
}

function clampToViewport(
  position: PanelPosition,
  panel: HTMLElement | null = null,
): PanelPosition {
  // A hidden always-mounted panel has no measurable width. Preserve the old
  // conservative fallback until ResizeObserver sees its real open size.
  const panelWidth = panel?.getBoundingClientRect().width || window.innerWidth
  return clampFloatingPanelPosition(position, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    panelWidth,
  })
}

function positionsEqual(a: PanelPosition, b: PanelPosition): boolean {
  return a.x === b.x && a.y === b.y
}

/** Shared persisted drag behavior for floating windows across admin workspaces. */
export function useDraggablePanel(
  panelId: FloatingPanelId,
  getDefault: () => PanelPosition,
): UseDraggablePanelResult {
  const [position, setPosition] = useState<PanelPosition>(() =>
    clampToViewport(readStoredPanelPosition(panelId) ?? getDefault()),
  )
  const positionRef = useRef<PanelPosition>(position)
  const panelRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  function applyMeasuredClamp(element: HTMLElement): void {
    const clamped = clampToViewport(positionRef.current, element)
    element.style.setProperty('--panel-x', `${clamped.x}px`)
    element.style.setProperty('--panel-y', `${clamped.y}px`)
    if (positionsEqual(positionRef.current, clamped)) return
    positionRef.current = clamped
    setPosition(clamped)
  }

  function setPanelRef(element: HTMLElement | null): void {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    panelRef.current = element
    if (!element) return

    applyMeasuredClamp(element)
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => applyMeasuredClamp(element))
      observer.observe(element)
      resizeObserverRef.current = observer
    }
  }

  useEffect(() => {
    positionRef.current = position
  }, [position])

  useEffect(() => () => resizeObserverRef.current?.disconnect(), [])

  useEffect(() => {
    writeStoredPanelPosition(panelId, position)
  }, [panelId, position])

  useEffect(() => {
    function onResize(): void {
      setPosition((current) => {
        const clamped = clampToViewport(current, panelRef.current)
        positionRef.current = clamped
        return positionsEqual(current, clamped) ? current : clamped
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).closest('button, input, select, textarea, a')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanelX: positionRef.current.x,
      startPanelY: positionRef.current.y,
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!dragRef.current) return
    const clamped = clampToViewport({
      x: dragRef.current.startPanelX + event.clientX - dragRef.current.startClientX,
      y: dragRef.current.startPanelY + event.clientY - dragRef.current.startClientY,
    }, panelRef.current)
    panelRef.current?.style.setProperty('--panel-x', `${clamped.x}px`)
    panelRef.current?.style.setProperty('--panel-y', `${clamped.y}px`)
  }

  function commitDragEnd(clientX: number, clientY: number): void {
    if (!dragRef.current) return
    const clamped = clampToViewport({
      x: dragRef.current.startPanelX + clientX - dragRef.current.startClientX,
      y: dragRef.current.startPanelY + clientY - dragRef.current.startClientY,
    }, panelRef.current)
    dragRef.current = null
    positionRef.current = clamped
    setPosition(clamped)
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    commitDragEnd(event.clientX, event.clientY)
  }

  function onPointerCancel(event: React.PointerEvent<HTMLDivElement>): void {
    commitDragEnd(event.clientX, event.clientY)
  }

  const panelPositionStyle = {
    '--panel-x': `${position.x}px`,
    '--panel-y': `${position.y}px`,
  } as React.CSSProperties

  return {
    panelRef,
    setPanelRef,
    headerDragProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    panelPositionStyle,
  }
}
