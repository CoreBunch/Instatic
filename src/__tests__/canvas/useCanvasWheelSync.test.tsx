import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup as cleanupRender, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { RESET_ZOOM } from '@site/canvas/math'
import {
  isCanvasPointerPanActive,
  isCanvasSpacePanActive,
  panDeltaFromWheel,
  setCanvasSpacePanActive,
  shouldStartCanvasPointerPan,
} from '@site/canvas/canvasPanInput'
import { useCanvas } from '@site/hooks/useCanvas'
import { installAdminZoomGuard } from '@admin/shared/AdminZoomGuard'

let cleanupZoomGuard: (() => void) | null = null

function TestCanvas() {
  const canvasRootRef = useRef<HTMLDivElement>(null)
  const transformLayerRef = useRef<HTMLDivElement>(null)
  const { bind } = useCanvas({ canvasRootRef, transformLayerRef, enabled: true })

  return (
    <div ref={canvasRootRef} data-testid="test-canvas-root" {...bind()}>
      <div ref={transformLayerRef} data-testid="test-transform-layer" />
    </div>
  )
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function dispatchWheel(target: Element, props: Record<string, unknown>) {
  const event = new Event('wheel', { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  target.dispatchEvent(event)
  return event
}

function dispatchPointer(target: Element, type: string, props: Record<string, unknown>) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  target.dispatchEvent(event)
  return event
}

function parseTranslate(transform: string): { x: number; y: number } {
  const match = /^translate\((-?\d+)px, (-?\d+)px\) scale\(1\)$/.exec(transform)
  if (!match) throw new Error(`Unexpected transform: ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}

beforeEach(() => {
  useEditorStore.setState({
    zoom: RESET_ZOOM,
    panX: 0,
    panY: 0,
    hoveredNodeId: null,
    hoveredBreakpointId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanupZoomGuard?.()
  cleanupZoomGuard = null
  cleanupRender()
})

describe('useCanvas wheel pan sync', () => {
  it('maps shift-wheel mouse scrolling to horizontal canvas pan', async () => {
    render(<TestCanvas />)

    const root = screen.getByTestId('test-canvas-root')
    const layer = screen.getByTestId('test-transform-layer')

    dispatchWheel(root, {
      shiftKey: true,
      deltaX: 0,
      deltaY: 120,
      clientX: 10,
      clientY: 10,
    })

    await act(async () => {
      await nextAnimationFrame()
    })

    expect(layer.style.transform).toBe('translate(-120px, 0px) scale(1)')
  })

  it('does not snap back to stale store pan when hover changes before the debounced pan commit', async () => {
    render(<TestCanvas />)

    const root = screen.getByTestId('test-canvas-root')
    const layer = screen.getByTestId('test-transform-layer')

    fireEvent.wheel(root, {
      deltaX: 120,
      deltaY: 0,
      clientX: 10,
      clientY: 10,
    })

    await act(async () => {
      await nextAnimationFrame()
    })

    expect(layer.style.transform).toBe('translate(-120px, 0px) scale(1)')

    act(() => {
      useEditorStore.getState().hoverNode('node-under-pointer', 'mobile')
    })

    expect(layer.style.transform).toBe('translate(-120px, 0px) scale(1)')
  })

  it('keeps ctrl-wheel zoom routed to the canvas when the admin zoom guard is installed', async () => {
    cleanupZoomGuard = installAdminZoomGuard(document)
    render(<TestCanvas />)

    const root = screen.getByTestId('test-canvas-root')
    const layer = screen.getByTestId('test-transform-layer')

    dispatchWheel(root, {
      ctrlKey: true,
      deltaY: -100,
      clientX: 10,
      clientY: 10,
    })

    await act(async () => {
      await nextAnimationFrame()
    })

    expect(layer.style.transform).toContain('scale(1.')
    expect(layer.style.transform).not.toBe('translate(0px, 0px) scale(1)')
  })

  it('pans the canvas with middle-mouse dragging', async () => {
    render(<TestCanvas />)

    const root = screen.getByTestId('test-canvas-root')
    const layer = screen.getByTestId('test-transform-layer')

    fireEvent.pointerDown(root, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 1,
      buttons: 4,
      clientX: 100,
      clientY: 100,
    })
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: 'mouse',
      button: -1,
      buttons: 4,
      clientX: 130,
      clientY: 140,
    })

    await act(async () => {
      await nextAnimationFrame()
    })

    const translate = parseTranslate(layer.style.transform)
    expect(translate.x).toBeGreaterThan(0)
    expect(translate.y).toBeGreaterThan(0)
  })

  it('prevents browser defaults when middle-mouse pan starts', () => {
    render(<TestCanvas />)

    const root = screen.getByTestId('test-canvas-root')

    const pointerDown = dispatchPointer(root, 'pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      button: 1,
      buttons: 4,
      clientX: 100,
      clientY: 100,
    })

    expect(pointerDown.defaultPrevented).toBe(true)
  })
})

describe('canvas mouse pan input policy', () => {
  it('tracks parent and iframe space-pan state independently for iframe pointer relays', () => {
    setCanvasSpacePanActive(document, 'parentDocument', true)
    expect(isCanvasSpacePanActive(document)).toBe(true)

    setCanvasSpacePanActive(document, 'iframe', true)
    setCanvasSpacePanActive(document, 'parentDocument', false)
    expect(isCanvasSpacePanActive(document)).toBe(true)

    setCanvasSpacePanActive(document, 'iframe', false)
    expect(isCanvasSpacePanActive(document)).toBe(false)
  })

  it('uses shift-wheel for sideways mouse scrolling', () => {
    expect(panDeltaFromWheel({ shiftKey: true, deltaX: 0, deltaY: 120 })).toEqual({ dx: -120, dy: 0 })
    expect(panDeltaFromWheel({ shiftKey: false, deltaX: 0, deltaY: 120 })).toEqual({ dx: 0, dy: -120 })
  })

  it('uses middle-button dragging as a canvas pan gesture', () => {
    expect(shouldStartCanvasPointerPan({ button: 1 }, { spaceHeld: false })).toBe(true)
    expect(shouldStartCanvasPointerPan({ button: 1 }, { spaceHeld: true })).toBe(true)
    expect(shouldStartCanvasPointerPan({ button: 0 }, { spaceHeld: false })).toBe(false)
    expect(shouldStartCanvasPointerPan({ button: 0 }, { spaceHeld: true })).toBe(true)
    expect(isCanvasPointerPanActive({ buttons: 4 }, { spaceHeld: false })).toBe(true)
    expect(isCanvasPointerPanActive({ buttons: 1 }, { spaceHeld: false })).toBe(false)
    expect(isCanvasPointerPanActive({ buttons: 1 }, { spaceHeld: true })).toBe(true)
  })
})
