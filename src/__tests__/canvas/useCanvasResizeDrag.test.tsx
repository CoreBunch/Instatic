/**
 * useCanvasResizeDrag — the selection handles' resize gesture.
 *
 * Pins the preview/commit split: pointer moves write the element's INLINE
 * style only (no store commit), release lands exactly ONE writeStyles with
 * the final size, and Escape mid-drag restores the pre-drag inline style
 * and commits nothing.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { useCanvasResizeDrag } from '@admin/pages/site/canvas/useCanvasResizeDrag'
import type { ResizeHandleDirection } from '@admin/pages/site/canvas/canvasSelectionOverlayPositioning'

function setupSelectedNode(): string {
  const store = useEditorStore.getState()
  const site = store.createSite('Resize Test')
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', {}, rootId)
  useEditorStore.getState().selectNode(nodeId)
  return nodeId
}

function mountCanvasIframe(nodeId: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('happy-dom iframe has no contentDocument')
  doc.body.innerHTML = `<div data-node-id="${nodeId}" style="width: 200px; height: 100px"></div>`
  return iframe
}

function begin(
  iframeElement: HTMLIFrameElement,
  writeStyles: ActiveStyleTarget['writeStyles'] | null,
  direction: ResizeHandleDirection,
  kind: ActiveStyleTarget['kind'] = 'class',
): void {
  const styleTarget: ActiveStyleTarget | null = writeStyles
    ? { kind, styles: {}, writeStyles }
    : null
  const { result } = renderHook(() => useCanvasResizeDrag({ iframeElement, styleTarget }))
  const event = {
    button: 0,
    clientX: 100,
    clientY: 100,
    pointerId: 1,
    preventDefault: () => {},
    stopPropagation: () => {},
    currentTarget: { setPointerCapture: () => {} },
  } as unknown as ReactPointerEvent<HTMLElement>
  result.current.begin(event, direction)
}

/** Waits out the hook's two-frame preview hold (plus one settle frame). */
function flushTwoFrames(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ),
  )
}

function element(iframe: HTMLIFrameElement, nodeId: string): HTMLElement {
  const el = iframe.contentDocument?.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)
  if (!el) throw new Error('canvas element missing')
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    lockedInsetSides: [],
    sizeRatioLocked: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('useCanvasResizeDrag', () => {
  it('previews inline during the move and commits once on release', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'se')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 150, clientY: 130, cancelable: true }),
    )

    // Mid-drag: inline preview only, no commit yet.
    expect(writeStyles).not.toHaveBeenCalled()
    expect(element(iframe, nodeId).style.width).toBe('250px')
    expect(element(iframe, nodeId).style.height).toBe('130px')

    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(writeStyles).toHaveBeenCalledTimes(1)
    const patch = writeStyles.mock.calls[0][0] as Record<string, string>
    expect(patch).toEqual({ width: '250px', height: '130px' })
  })

  it('echoes the live patch into canvasGesturePreview and clears it on release', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'se')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 150, clientY: 130, cancelable: true }),
    )

    // Mid-drag the inspector's session channel carries the live values…
    expect(useEditorStore.getState().canvasGesturePreview).toEqual({
      width: '250px',
      height: '130px',
    })

    window.dispatchEvent(new MouseEvent('pointerup'))
    // …and release clears it — the committed store values take over.
    expect(useEditorStore.getState().canvasGesturePreview).toBeNull()
  })

  it('an edge handle touches only its axis', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'e')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 140, clientY: 999, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    const patch = writeStyles.mock.calls[0][0] as Record<string, string>
    expect(patch).toEqual({ width: '240px' })
  })

  it('refuses the inline fallback on a non-base breakpoint — no cross-breakpoint leak', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    useEditorStore.setState({ activeBreakpointId: 'tablet' })

    begin(iframe, null, 'se')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 150, clientY: 130, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    // The gesture never started: no preview on the element, no inline commit.
    expect(element(iframe, nodeId).style.width).toBe('200px')
    const state = useEditorStore.getState()
    const node = state.site?.pages.find((p) => p.id === state.activePageId)?.nodes[nodeId]
    expect(node?.inlineStyles).toBeUndefined()
  })

  it('falls back to node inline styles when no style target is active', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)

    begin(iframe, null, 'se')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 150, clientY: 130, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    const state = useEditorStore.getState()
    const node = state.site?.pages.find((p) => p.id === state.activePageId)?.nodes[nodeId]
    expect(node?.inlineStyles).toMatchObject({ width: '250px', height: '130px' })
  })

  it('a class-target commit rolls the inline preview back after two frames', async () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'se', 'class')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 150, clientY: 130, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    await flushTwoFrames()
    // The committed size lives in the injected class CSS, so the element's
    // style attribute must return to its pre-drag values.
    expect(element(iframe, nodeId).style.width).toBe('200px')
    expect(element(iframe, nodeId).style.height).toBe('100px')
  })

  it('an inline-target commit keeps the preview — restoring would wipe the commit', async () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'se', 'inline')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 150, clientY: 130, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    await flushTwoFrames()
    // The commit lands in the SAME style attribute the preview wrote — the
    // preview IS the committed state and must stay (React's style-prop diff
    // never re-applies values it believes are already set).
    expect(element(iframe, nodeId).style.width).toBe('250px')
    expect(element(iframe, nodeId).style.height).toBe('130px')
  })

  it('keeps the ratio while the Size lock is on — an edge handle derives the other axis', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})
    useEditorStore.getState().setSizeRatioLocked(true)

    // 200×100 → dragging E to 300 wide must land at 150 tall.
    begin(iframe, writeStyles, 'e')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 200, clientY: 100, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(writeStyles.mock.calls[0][0]).toEqual({ width: '300px', height: '150px' })
  })

  it('a corner drag under the lock follows the axis the pointer moved more', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})
    useEditorStore.getState().setSizeRatioLocked(true)

    begin(iframe, writeStyles, 'se')
    // +20 wide, +80 tall: height leads → 180 tall, width follows at 360.
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 120, clientY: 180, cancelable: true }),
    )
    window.dispatchEvent(new MouseEvent('pointerup'))

    expect(writeStyles.mock.calls[0][0]).toEqual({ width: '360px', height: '180px' })
  })

  it('Escape mid-drag restores the inline style and commits nothing', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock(() => {})

    begin(iframe, writeStyles, 'se')
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 180, clientY: 180, cancelable: true }),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(writeStyles).not.toHaveBeenCalled()
    expect(element(iframe, nodeId).style.width).toBe('200px')
    expect(element(iframe, nodeId).style.height).toBe('100px')

    // The gesture is over — a later pointerup must not commit either.
    window.dispatchEvent(new MouseEvent('pointerup'))
    expect(writeStyles).not.toHaveBeenCalled()
  })
})
