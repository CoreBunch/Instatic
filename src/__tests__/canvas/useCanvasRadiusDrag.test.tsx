/**
 * useCanvasRadiusDrag — the corner-dot rounding gesture.
 *
 * Pins the corner maths on top of the shared canvas style gesture: pulling a
 * dot inward grows the radius on all four corners (Alt: only the grabbed
 * one), the preview is inline-only, release commits exactly ONE patch, and a
 * stored `borderRadius` shorthand is cleared so the longhands win.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { useCanvasRadiusDrag } from '@admin/pages/site/canvas/useCanvasRadiusDrag'
import type { RadiusHandleCorner } from '@admin/pages/site/canvas/canvasSelectionOverlayPositioning'

function setupSelectedNode(): string {
  const store = useEditorStore.getState()
  const site = store.createSite('Radius Test')
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', {}, rootId)
  useEditorStore.getState().selectNode(nodeId)
  return nodeId
}

const UNIFORM_10PX =
  'border-top-left-radius: 10px; border-top-right-radius: 10px; border-bottom-right-radius: 10px; border-bottom-left-radius: 10px'

function mountCanvasIframe(nodeId: string, radii = UNIFORM_10PX): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('happy-dom iframe has no contentDocument')
  doc.body.innerHTML = `<div data-node-id="${nodeId}" style="width: 200px; height: 100px; ${radii}"></div>`
  return iframe
}

function begin(
  iframeElement: HTMLIFrameElement,
  writeStyles: ActiveStyleTarget['writeStyles'] | null,
  corner: RadiusHandleCorner,
  options: { altKey?: boolean; styles?: ActiveStyleTarget['styles'] } = {},
): void {
  const styleTarget: ActiveStyleTarget | null = writeStyles
    ? { kind: 'class', styles: options.styles ?? {}, writeStyles }
    : null
  const { result } = renderHook(() => useCanvasRadiusDrag({ iframeElement, styleTarget }))
  const event = {
    button: 0,
    altKey: options.altKey ?? false,
    clientX: 100,
    clientY: 100,
    pointerId: 1,
    preventDefault: () => {},
    stopPropagation: () => {},
    currentTarget: { setPointerCapture: () => {} },
  } as unknown as ReactPointerEvent<HTMLElement>
  result.current.begin(event, corner)
}

function element(iframe: HTMLIFrameElement, nodeId: string): HTMLElement {
  const el = iframe.contentDocument?.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)
  if (!el) throw new Error('canvas element missing')
  return el
}

const ALL_CORNERS = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
] as const

beforeEach(() => {
  document.body.innerHTML = ''
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    lockedInsetSides: [],
    radiusScope: null,
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('useCanvasRadiusDrag', () => {
  it('pulling the top-left dot inward rounds all four corners from that corner’s radius', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'nw')
    // 20px right and 20px down = 20px along the inward diagonal.
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 120, clientY: 120, cancelable: true }),
    )

    expect(writeStyles).not.toHaveBeenCalled()
    expect(element(iframe, nodeId).style.borderTopLeftRadius).toBe('30px')
    expect(element(iframe, nodeId).style.borderBottomRightRadius).toBe('30px')

    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(writeStyles).toHaveBeenCalledTimes(1)
    const patch = writeStyles.mock.calls[0][0] as Record<string, string>
    expect(patch).toEqual(Object.fromEntries(ALL_CORNERS.map((key) => [key, '30px'])))
  })

  it('caps the radius at half the shorter side and never goes negative', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'nw')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 400, clientY: 400, cancelable: true }),
    )
    expect(element(iframe, nodeId).style.borderTopLeftRadius).toBe('50px')

    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 0, clientY: 0, cancelable: true }),
    )
    expect(element(iframe, nodeId).style.borderTopLeftRadius).toBe('0px')
  })

  it('Alt in linked scope rounds only the grabbed corner, on its own inward diagonal', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    // Bottom-right: inward is left and up.
    begin(iframe, writeStyles, 'se', { altKey: true })
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 84, clientY: 84, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    const patch = writeStyles.mock.calls[0][0] as Record<string, string>
    expect(patch).toEqual({ borderBottomRightRadius: '26px' })
    expect(element(iframe, nodeId).style.borderTopLeftRadius).toBe('10px')
  })

  it('follows the Radius row: in "separately" scope a plain drag rounds one corner, Alt all four', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})
    useEditorStore.getState().setRadiusScope('parts')

    begin(iframe, writeStyles, 'nw')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 120, clientY: 120, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(writeStyles.mock.calls[0][0]).toEqual({ borderTopLeftRadius: '30px' })

    begin(iframe, writeStyles, 'nw', { altKey: true })
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 110, clientY: 110, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(writeStyles.mock.calls[1][0]).toEqual(
      Object.fromEntries(ALL_CORNERS.map((key) => [key, '40px'])),
    )
  })

  it('with no scope chosen, corners that already differ are edited separately', () => {
    const nodeId = setupSelectedNode()
    const writeStyles = mock(() => {})
    // A 10px top-left corner and 0 elsewhere — already split.
    const iframe = mountCanvasIframe(nodeId, 'border-top-left-radius: 10px')
    begin(iframe, writeStyles, 'ne')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 90, clientY: 110, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(writeStyles.mock.calls[0][0]).toEqual({ borderTopRightRadius: '10px' })
  })

  it('clears a stored borderRadius shorthand so the longhands are not shadowed', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'nw', { styles: { borderRadius: '4px' } })
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 110, clientY: 110, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    const patch = writeStyles.mock.calls[0][0] as Record<string, string | undefined>
    expect(patch.borderRadius).toBeUndefined()
    expect('borderRadius' in patch).toBe(true)
    expect(patch.borderTopLeftRadius).toBe('20px')
  })

  it('Escape mid-drag restores the inline style and commits nothing', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'nw')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 130, clientY: 130, cancelable: true }),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(writeStyles).not.toHaveBeenCalled()
    expect(element(iframe, nodeId).style.borderTopLeftRadius).toBe('10px')
    expect(element(iframe, nodeId).style.borderBottomRightRadius).toBe('10px')

    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(writeStyles).not.toHaveBeenCalled()
  })
})
