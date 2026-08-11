import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  RefObject,
} from 'react'
import {
  readStoredPanelSize,
  writeStoredPanelSize,
  type FloatingPanelId,
  type PanelSize,
} from '@admin/state/workspaceLayoutStorage'

const VIEWPORT_MARGIN = 16
const KEYBOARD_STEP = 10
const LARGE_KEYBOARD_STEP = 40

interface ResizeBounds {
  viewportWidth: number
  viewportHeight: number
  panelLeft: number
  panelTop: number
  minWidth: number
  minHeight: number
}

interface ResizeState extends ResizeBounds {
  startClientX: number
  startClientY: number
  startWidth: number
  startHeight: number
}

interface ResizablePanelOptions {
  minWidth?: number
  minHeight?: number
}

export interface PanelResizeHandleProps {
  ref: RefObject<HTMLDivElement | null>
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  'aria-valuemin': number
  'aria-valuemax': number
  'aria-valuenow': number
  'aria-valuetext': string
}

interface UseResizablePanelResult {
  panelSizeStyle: CSSProperties
  resizeHandleProps: PanelResizeHandleProps
}

/** Keep a floating panel usable while its bottom-right corner is resized. */
export function clampFloatingPanelSize(
  size: PanelSize,
  bounds: ResizeBounds,
): PanelSize {
  const availableWidth = Math.max(
    bounds.minWidth,
    bounds.viewportWidth - Math.max(bounds.panelLeft, VIEWPORT_MARGIN) - VIEWPORT_MARGIN,
  )
  const availableHeight = Math.max(
    bounds.minHeight,
    bounds.viewportHeight - Math.max(bounds.panelTop, 0) - VIEWPORT_MARGIN,
  )
  return {
    width: Math.max(bounds.minWidth, Math.min(size.width, availableWidth)),
    height: Math.max(bounds.minHeight, Math.min(size.height, availableHeight)),
  }
}

function sizesEqual(a: PanelSize, b: PanelSize): boolean {
  return a.width === b.width && a.height === b.height
}

function viewportBounds(
  panel: HTMLElement | null,
  minWidth: number,
  minHeight: number,
): ResizeBounds {
  const rect = panel?.getBoundingClientRect()
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    panelLeft: rect?.left ?? VIEWPORT_MARGIN,
    panelTop: rect?.top ?? 64,
    minWidth,
    minHeight,
  }
}

function sizeFromPointer(resize: ResizeState, clientX: number, clientY: number): PanelSize {
  return clampFloatingPanelSize({
    width: resize.startWidth + clientX - resize.startClientX,
    height: resize.startHeight + clientY - resize.startClientY,
  }, resize)
}

/**
 * Persisted two-axis resizing for a floating panel. Pointer movement writes
 * CSS variables directly so resizing stays smooth; React state commits once
 * the gesture ends.
 */
export function useResizablePanel(
  panelId: FloatingPanelId,
  panelRef: RefObject<HTMLElement | null>,
  getDefault: () => PanelSize,
  {
    minWidth = 280,
    minHeight = 240,
  }: ResizablePanelOptions = {},
): UseResizablePanelResult {
  const [size, setSize] = useState<PanelSize>(() => {
    const initial = readStoredPanelSize(panelId) ?? getDefault()
    if (typeof window === 'undefined') return initial
    return clampFloatingPanelSize(initial, viewportBounds(null, minWidth, minHeight))
  })
  const sizeRef = useRef(size)
  const resizeRef = useRef<ResizeState | null>(null)
  const handleRef = useRef<HTMLDivElement | null>(null)

  // useCallback kept: stable identity for the [applyLiveSize] effect dependency.
  const applyLiveSize = useCallback((nextSize: PanelSize): void => {
    sizeRef.current = nextSize
    panelRef.current?.style.setProperty('--panel-w', `${nextSize.width}px`)
    panelRef.current?.style.setProperty('--panel-h', `${nextSize.height}px`)
    handleRef.current?.setAttribute(
      'aria-valuetext',
      `${Math.round(nextSize.width)} by ${Math.round(nextSize.height)} pixels`,
    )
    handleRef.current?.setAttribute('aria-valuenow', String(Math.round(nextSize.width)))
  }, [panelRef])

  useEffect(() => {
    sizeRef.current = size
    applyLiveSize(size)
  }, [applyLiveSize, size])

  useEffect(() => {
    writeStoredPanelSize(panelId, size)
  }, [panelId, size])

  useEffect(() => {
    function onResize(): void {
      if (resizeRef.current) return
      const clamped = clampFloatingPanelSize(
        sizeRef.current,
        viewportBounds(panelRef.current, minWidth, minHeight),
      )
      applyLiveSize(clamped)
      setSize((current) => sizesEqual(current, clamped) ? current : clamped)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyLiveSize, minHeight, minWidth, panelRef])

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    resizeRef.current = {
      ...viewportBounds(panel, minWidth, minHeight),
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopPropagation()
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!resizeRef.current) return
    applyLiveSize(sizeFromPointer(resizeRef.current, event.clientX, event.clientY))
  }

  function commitPointerResize(clientX: number, clientY: number): void {
    if (!resizeRef.current) return
    const nextSize = sizeFromPointer(resizeRef.current, clientX, clientY)
    resizeRef.current = null
    applyLiveSize(nextSize)
    setSize(nextSize)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    commitPointerResize(event.clientX, event.clientY)
  }

  function onPointerCancel(event: PointerEvent<HTMLDivElement>): void {
    commitPointerResize(event.clientX, event.clientY)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? LARGE_KEYBOARD_STEP : KEYBOARD_STEP
    const delta = {
      width: event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0,
      height: event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0,
    }
    if (delta.width === 0 && delta.height === 0) return
    event.preventDefault()
    event.stopPropagation()
    const nextSize = clampFloatingPanelSize({
      width: sizeRef.current.width + delta.width,
      height: sizeRef.current.height + delta.height,
    }, viewportBounds(panelRef.current, minWidth, minHeight))
    applyLiveSize(nextSize)
    setSize(nextSize)
  }

  const maxWidth = typeof window === 'undefined' ? size.width : window.innerWidth
  const panelSizeStyle = {
    '--panel-w': `${size.width}px`,
    '--panel-h': `${size.height}px`,
  } as CSSProperties

  return {
    panelSizeStyle,
    resizeHandleProps: {
      ref: handleRef,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown,
      'aria-valuemin': minWidth,
      'aria-valuemax': maxWidth,
      'aria-valuenow': Math.round(size.width),
      'aria-valuetext': `${Math.round(size.width)} by ${Math.round(size.height)} pixels`,
    },
  }
}
