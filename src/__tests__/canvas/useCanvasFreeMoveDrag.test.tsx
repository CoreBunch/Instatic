/**
 * useCanvasFreeMoveDrag — pinned inset edges constrain the canvas drag.
 *
 * The pins in the Position section's inset box are store state
 * (`lockedInsetSides`), and the free-move drag is the other consumer of that
 * contract: a pinned left/right freezes the horizontal axis (no `left`
 * write), a pinned top/bottom freezes the vertical (no `top` write), and
 * pinning both axes disables free-move entirely so the pointer-down falls
 * through to the reorder drag.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import { useCanvasFreeMoveDrag } from '@admin/pages/site/canvas/useCanvasFreeMoveDrag'

function setupSelectedNode(): string {
  const store = useEditorStore.getState()
  const site = store.createSite('Free Move Test')
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', {}, rootId)
  useEditorStore.getState().selectNode(nodeId)
  return nodeId
}

/** A bare iframe whose document holds the positioned canvas element. */
function mountCanvasIframe(nodeId: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const doc = iframe.contentDocument
  if (!doc) throw new Error('happy-dom iframe has no contentDocument')
  doc.body.innerHTML = `<div data-node-id="${nodeId}" style="position: absolute; left: 10px; top: 20px"></div>`
  return iframe
}

function beginDrag(
  iframeElement: HTMLIFrameElement,
  writeStyles: ActiveStyleTarget['writeStyles'],
  styles: ActiveStyleTarget['styles'] = {},
  kind: ActiveStyleTarget['kind'] = 'class',
): boolean {
  const styleTarget: ActiveStyleTarget = { kind, styles, writeStyles }
  const { result } = renderHook(() => useCanvasFreeMoveDrag({ iframeElement, styleTarget }))
  const event = {
    button: 0,
    clientX: 100,
    clientY: 100,
    pointerId: 1,
    preventDefault: () => {},
    stopPropagation: () => {},
    currentTarget: { setPointerCapture: () => {} },
  } as unknown as ReactPointerEvent<HTMLElement>
  return result.current.tryBegin(event)
}

/** One diagonal pointer move (+50, +50 screen px) followed by release. */
function dragDiagonallyAndRelease() {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 150, clientY: 150, cancelable: true }))
  window.dispatchEvent(new MouseEvent('pointerup'))
}

beforeEach(() => {
  document.body.innerHTML = ''
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    lockedInsetSides: [],
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('useCanvasFreeMoveDrag with pinned inset edges', () => {
  it('an unpinned element writes both offsets', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(beginDrag(iframe, writeStyles)).toBe(true)
    dragDiagonallyAndRelease()

    expect(writeStyles).toHaveBeenCalled()
    const patch = writeStyles.mock.calls[0][0]
    expect(Object.keys(patch).sort()).toEqual(['left', 'top'])
  })

  it('a pinned left edge freezes the horizontal axis — no left write', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    useEditorStore.getState().toggleInsetLock('left')
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(beginDrag(iframe, writeStyles)).toBe(true)
    dragDiagonallyAndRelease()

    expect(writeStyles).toHaveBeenCalled()
    for (const [patch] of writeStyles.mock.calls) {
      expect(Object.keys(patch)).toEqual(['top'])
    }
  })

  it('a pinned bottom edge freezes the vertical axis — no top write', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    useEditorStore.getState().toggleInsetLock('bottom')
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(beginDrag(iframe, writeStyles)).toBe(true)
    dragDiagonallyAndRelease()

    expect(writeStyles).toHaveBeenCalled()
    for (const [patch] of writeStyles.mock.calls) {
      expect(Object.keys(patch)).toEqual(['left'])
    }
  })

  it('stored right/bottom anchors move with mirrored deltas instead of a new left/top', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(beginDrag(iframe, writeStyles, { right: '10px', bottom: '20px' })).toBe(true)
    dragDiagonallyAndRelease()

    expect(writeStyles).toHaveBeenCalled()
    const patch = writeStyles.mock.calls[0][0]
    expect(Object.keys(patch).sort()).toEqual(['bottom', 'right'])
  })

  it('all four stored offsets update together', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(
      beginDrag(iframe, writeStyles, {
        left: '10px',
        top: '20px',
        right: '30px',
        bottom: '40px',
      }),
    ).toBe(true)
    dragDiagonallyAndRelease()

    expect(writeStyles).toHaveBeenCalled()
    const patch = writeStyles.mock.calls[0][0]
    expect(Object.keys(patch).sort()).toEqual(['bottom', 'left', 'right', 'top'])
  })

  it('an inline-target commit keeps the preview — restoring would wipe the commit', async () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(beginDrag(iframe, writeStyles, {}, 'inline')).toBe(true)
    dragDiagonallyAndRelease()

    // Wait past the two-frame preview hold: the commit lives in the SAME
    // style attribute the preview wrote, so the moved offsets must stay.
    await new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
    )
    const el = iframe.contentDocument?.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)
    expect(el?.style.left).toBe('60px')
    expect(el?.style.top).toBe('70px')
  })

  it('both axes pinned refuses the free-move drag entirely', () => {
    const nodeId = setupSelectedNode()
    const iframe = mountCanvasIframe(nodeId)
    useEditorStore.getState().toggleInsetLock('top')
    useEditorStore.getState().toggleInsetLock('right')
    const writeStyles = mock((_patch: Partial<CSSPropertyBag>) => {})

    expect(beginDrag(iframe, writeStyles)).toBe(false)
    expect(writeStyles).not.toHaveBeenCalled()
  })
})
