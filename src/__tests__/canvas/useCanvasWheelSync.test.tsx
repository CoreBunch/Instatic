import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useRef } from 'react'
import { act, cleanup as cleanupRender, fireEvent, render, screen } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { RESET_ZOOM } from '@site/canvas/math'
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
})
