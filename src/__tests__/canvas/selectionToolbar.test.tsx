import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { CanvasViewportActionsContext } from '@site/canvas/CanvasContexts'
import { useEditorStore } from '@site/store/store'
import type { Page } from '@core/page-tree'
import '@modules/base/index'

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    activeClassId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function createSelectedTextPage(): { page: Page; textId: string } {
  const site = useEditorStore.getState().createSite('Toolbar Test')
  const rootId = site.pages[0].rootNodeId
  const textId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'Selected text', tag: 'p' },
    rootId,
  )
  const page = useEditorStore.getState().site!.pages[0]
  useEditorStore.setState({
    selectedNodeId: textId,
    selectedNodeIds: [textId],
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
  return { page, textId }
}

function createSortableTextPage(): {
  page: Page
  rootId: string
  firstId: string
  secondId: string
  thirdId: string
} {
  const site = useEditorStore.getState().createSite('Canvas Drag Test')
  const rootId = site.pages[0].rootNodeId
  const firstId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'First', tag: 'p' },
    rootId,
  )
  const secondId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'Second', tag: 'p' },
    rootId,
  )
  const thirdId = useEditorStore.getState().insertNode(
    'base.text',
    { text: 'Third', tag: 'p' },
    rootId,
  )
  const page = useEditorStore.getState().site!.pages[0]
  useEditorStore.setState({
    selectedNodeId: secondId,
    selectedNodeIds: [secondId],
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
  return { page, rootId, firstId, secondId, thirdId }
}

function createMultiSortableTextPage(): {
  page: Page
  rootId: string
  firstId: string
  secondId: string
  thirdId: string
  fourthId: string
} {
  const site = useEditorStore.getState().createSite('Canvas Multi Drag Test')
  const rootId = site.pages[0].rootNodeId
  const firstId = useEditorStore.getState().insertNode('base.text', { text: 'First', tag: 'p' }, rootId)
  const secondId = useEditorStore.getState().insertNode('base.text', { text: 'Second', tag: 'p' }, rootId)
  const thirdId = useEditorStore.getState().insertNode('base.text', { text: 'Third', tag: 'p' }, rootId)
  const fourthId = useEditorStore.getState().insertNode('base.text', { text: 'Fourth', tag: 'p' }, rootId)
  const page = useEditorStore.getState().site!.pages[0]
  useEditorStore.setState({
    selectedNodeId: thirdId,
    selectedNodeIds: [secondId, thirdId],
    activeBreakpointId: 'desktop',
  } as Parameters<typeof useEditorStore.setState>[0])
  return { page, rootId, firstId, secondId, thirdId, fourthId }
}

function installCanvasRects(rects: Record<string, DOMRectInit>) {
  // The canvas now renders each breakpoint frame inside an iframe, and each
  // iframe has its OWN `HTMLElement` constructor (so a patch on the parent
  // prototype doesn't reach elements inside the iframe). We patch both the
  // parent prototype and any iframe content windows that exist now or are
  // added later via a MutationObserver. Tests measure ints inside the iframe
  // (`[data-node-id]` lives there) and the parent (`[data-canvas-test-root]`,
  // `[data-breakpoint-id]` on the viewport wrapper).
  const mockedReturn = (element: HTMLElement) => {
    if (element.dataset.canvasTestRoot === 'true') {
      return testRect({ x: 0, y: 0, width: 200, height: 200 })
    }
    if (element.dataset.breakpointId === 'desktop') {
      return testRect({ x: 0, y: 0, width: 400, height: 400 })
    }
    if (element.tagName === 'IFRAME') {
      // The iframe's own rect — parent coords. Use the same `400` square as
      // the viewport wrapper so iframe-internal coords already line up with
      // editor-doc coords (the production translation adds iframe.left/top
      // which is 0,0 here).
      return testRect({ x: 0, y: 0, width: 400, height: 400 })
    }
    // Resolve the owning node by walking up via `parentElement` rather than
    // `.closest()`. `.closest()` works fine on plain elements, but happy-dom
    // sometimes returns null when a node lives inside an iframe and the
    // search would cross the document boundary. Hand-walking the chain is
    // robust to that.
    let owner: HTMLElement | null = element
    while (owner && !owner.dataset?.nodeId) {
      owner = owner.parentElement
    }
    const nodeId = owner?.dataset?.nodeId
    const rect = nodeId ? rects[nodeId] : null
    return testRect(rect ?? { x: 0, y: 0, width: 0, height: 0 })
  }
  const restorers: Array<() => void> = []
  const patchProto = (proto: { getBoundingClientRect: () => DOMRect }) => {
    const original = proto.getBoundingClientRect
    proto.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
      return mockedReturn(this)
    }
    restorers.push(() => {
      proto.getBoundingClientRect = original
    })
  }
  patchProto(HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect })
  // Patch the iframe documents that exist right now…
  const patchExistingIframes = () => {
    for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
      const win = iframe.contentWindow as unknown as { HTMLElement?: { prototype: { getBoundingClientRect: () => DOMRect } } } | null
      const iframeProto = win?.HTMLElement?.prototype
      // Skip if the iframe shares the parent prototype (same window) — already patched.
      if (iframeProto && iframeProto !== (HTMLElement.prototype as unknown as object)) {
        patchProto(iframeProto)
      }
    }
  }
  patchExistingIframes()
  // …and any iframes created later (the canvas mounts iframes asynchronously
  // on first commit so the patch above only catches them if it runs after
  // render).
  const observer = new MutationObserver(patchExistingIframes)
  observer.observe(document.body, { childList: true, subtree: true })
  restorers.push(() => observer.disconnect())
  return () => {
    for (const restore of restorers) restore()
  }
}

function CanvasActionsTestProvider({
  children,
  panBy,
}: {
  children: ReactNode
  panBy: (dx: number, dy: number) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef} data-canvas-test-root="true">
      <CanvasViewportActionsContext.Provider value={{ canvasRootRef: rootRef, panBy }}>
        {children}
      </CanvasViewportActionsContext.Provider>
    </div>
  )
}

function installRafQueue() {
  const originalRaf = globalThis.requestAnimationFrame
  const originalCancel = globalThis.cancelAnimationFrame
  const callbacks: FrameRequestCallback[] = []
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callbacks.push(callback)
    return callbacks.length
  }) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  return {
    flushOne: () => callbacks.shift()?.(performance.now()),
    restore: () => {
      globalThis.requestAnimationFrame = originalRaf
      globalThis.cancelAnimationFrame = originalCancel
    },
  }
}

function testRect(rect: DOMRectInit): DOMRect {
  const x = rect.x ?? 0
  const y = rect.y ?? 0
  const width = rect.width ?? 0
  const height = rect.height ?? 0
  return {
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(resetStore)
afterEach(() => {
  cleanup()
  resetStore()
})

describe('canvas selection toolbar', () => {
  it('renders one drag handle on the active breakpoint frame only', () => {
    const { page } = createSelectedTextPage()

    render(
      <>
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' }}
          isActive={false}
          onActivate={() => {}}
        />
      </>,
    )

    expect(screen.getAllByRole('button', { name: 'Drag selected layers' })).toHaveLength(1)
  })

  it('renders selection actions and positions the toolbar above the selected layer even outside the frame', () => {
    const { page, textId } = createSelectedTextPage()
    const restoreRects = installCanvasRects({
      [textId]: { x: 20, y: 10, width: 160, height: 40 },
    })
    const raf = installRafQueue()

    try {
      render(
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />,
      )

      act(() => {
        // Iframe content is mounted on the iframe's `load` event (microtask
        // in happy-dom). One RAF tick may run before the iframe portal has
        // populated, and sibling overlays (peer presence) enqueue their own
        // portal-capture frames — flush a few so the positioning tick runs.
        raf.flushOne()
        raf.flushOne()
        raf.flushOne()
        raf.flushOne()
        raf.flushOne()
      })

      const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))
      const hasNode = iframes.some((i) => i.contentDocument?.querySelector('[data-node-id]') !== null)

      const toolbar = screen.getByRole('group', { name: 'Selection actions' })
      expect(toolbar.parentElement).toBe(document.body)
      // Iframe-internal node detection is a precondition for accurate toolbar
      // positioning. If the iframe portal hasn't mounted yet, raise a clear
      // error instead of a confusing empty-CSS-var assertion.
      expect(hasNode).toBe(true)
      expect(toolbar.style.left).toBe('20px')
      expect(toolbar.style.top).toBe('-20px')
      expect(screen.getByRole('button', { name: 'Drag selected layers' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Duplicate selected layers' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Delete selected layers' })).toBeTruthy()
    } finally {
      raf.restore()
      restoreRects()
    }
  })

  it('duplicates selected layers from the selection toolbar', () => {
    const { page, textId } = createSelectedTextPage()
    const rootId = page.rootNodeId

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Duplicate selected layers' }))
    })

    const currentPage = useEditorStore.getState().site!.pages[0]
    const children = currentPage.nodes[rootId].children
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(textId)
    expect(currentPage.nodes[children[1]].moduleId).toBe('base.text')
  })

  it('deletes selected layers from the selection toolbar', () => {
    const { page, textId } = createSelectedTextPage()
    const rootId = page.rootNodeId

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete selected layers' }))
    })

    const currentPage = useEditorStore.getState().site!.pages[0]
    expect(currentPage.nodes[rootId].children).toEqual([])
    expect(currentPage.nodes[textId]).toBeUndefined()
    expect(useEditorStore.getState().selectedNodeIds).toEqual([])
  })

  it('renders the insert-module action in the second toolbar position', () => {
    const { page } = createSelectedTextPage()

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    const toolbar = screen.getByRole('group', { name: 'Selection actions' })
    const buttons = Array.from(toolbar.querySelectorAll('button'))
    const labels = buttons.map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual([
      'Drag selected layers',
      'Insert module',
      'Add selected layers to AI chat',
      'Duplicate selected layers',
      'Delete selected layers',
    ])
  })

  it('does not bubble toolbar clicks to the canvas background', () => {
    // Regression: the toolbar is portaled into the canvas root, whose onClick
    // clears the selection on background clicks. A toolbar click must not
    // bubble up — otherwise opening the Insert-module dialog would clear the
    // selection and unmount the toolbar mid-click.
    const { page } = createSelectedTextPage()
    let backgroundClicks = 0

    function Harness() {
      const rootRef = useRef<HTMLDivElement>(null)
      return (
        <div
          ref={rootRef}
          data-canvas-test-root="true"
          onClick={() => {
            backgroundClicks += 1
          }}
        >
          <CanvasViewportActionsContext.Provider value={{ canvasRootRef: rootRef, panBy: () => {} }}>
            <BreakpointFrame
              page={page}
              breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
              isActive
              onActivate={() => {}}
            />
          </CanvasViewportActionsContext.Provider>
        </div>
      )
    }

    render(<Harness />)

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Insert module' }))
    })

    expect(backgroundClicks).toBe(0)
    // The module inserter dialog opened and stayed open (selection still intact).
    expect(screen.getByRole('dialog', { name: 'Add to canvas' })).toBeTruthy()
  })

  it('inserts a module inside a nestable selected layer from the toolbar', () => {
    const site = useEditorStore.getState().createSite('Insert Nestable Test')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const page = useEditorStore.getState().site!.pages[0]
    useEditorStore.setState({
      selectedNodeId: containerId,
      selectedNodeIds: [containerId],
      activeBreakpointId: 'desktop',
    } as Parameters<typeof useEditorStore.setState>[0])

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Insert module' }))
    })
    act(() => {
      fireEvent.click(document.querySelector('[data-module-id="base.text"]')!)
    })

    const currentPage = useEditorStore.getState().site!.pages[0]
    // Nestable target → new node lands as a last child of the container.
    const childIds = currentPage.nodes[containerId].children
    expect(childIds).toHaveLength(1)
    expect(currentPage.nodes[childIds[0]].moduleId).toBe('base.text')
    expect(currentPage.nodes[rootId].children).toEqual([containerId])
  })

  it('inserts a module as a sibling of a non-nestable selected layer from the toolbar', () => {
    const { page, textId } = createSelectedTextPage()
    const rootId = page.rootNodeId

    render(
      <BreakpointFrame
        page={page}
        breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
        isActive
        onActivate={() => {}}
      />,
    )

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Insert module' }))
    })
    act(() => {
      fireEvent.click(document.querySelector('[data-module-id="base.text"]')!)
    })

    const currentPage = useEditorStore.getState().site!.pages[0]
    // Leaf target → new node lands as the next sibling under the shared parent.
    const children = currentPage.nodes[rootId].children
    expect(children).toHaveLength(2)
    expect(children[0]).toBe(textId)
    expect(currentPage.nodes[children[1]].moduleId).toBe('base.text')
  })

  it('moves the selected layer when its drag handle is released over a canvas after-zone', () => {
    const { page, rootId, firstId, secondId, thirdId } = createSortableTextPage()
    const restoreRects = installCanvasRects({
      [rootId]: { x: 0, y: 0, width: 400, height: 300 },
      [firstId]: { x: 20, y: 10, width: 160, height: 40 },
      [secondId]: { x: 20, y: 60, width: 160, height: 40 },
      [thirdId]: { x: 20, y: 120, width: 160, height: 40 },
    })

    try {
      render(
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />,
      )

      const handle = screen.getByRole('button', { name: 'Drag selected layers' })
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 32, clientY: 64 })
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 32, clientY: 156 })
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 32, clientY: 156 })
      })

      const currentPage = useEditorStore.getState().site!.pages[0]
      expect(currentPage.nodes[rootId].children).toEqual([firstId, thirdId, secondId])
    } finally {
      restoreRects()
    }
  })

  it('moves a multi-selection as one ordered batch from the canvas drag handle', () => {
    const { page, rootId, firstId, secondId, thirdId, fourthId } = createMultiSortableTextPage()
    const restoreRects = installCanvasRects({
      [rootId]: { x: 0, y: 0, width: 400, height: 360 },
      [firstId]: { x: 20, y: 10, width: 160, height: 40 },
      [secondId]: { x: 20, y: 60, width: 160, height: 40 },
      [thirdId]: { x: 20, y: 110, width: 160, height: 40 },
      [fourthId]: { x: 20, y: 170, width: 160, height: 40 },
    })

    try {
      render(
        <BreakpointFrame
          page={page}
          breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
          isActive
          onActivate={() => {}}
        />,
      )

      const handle = screen.getByRole('button', { name: 'Drag selected layers' })
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 32, clientY: 114 })
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 32, clientY: 206 })
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 32, clientY: 206 })
      })

      const currentPage = useEditorStore.getState().site!.pages[0]
      expect(currentPage.nodes[rootId].children).toEqual([firstId, fourthId, secondId, thirdId])
    } finally {
      restoreRects()
    }
  })

  it('auto-pans the canvas when a handle drag moves near the canvas edge', () => {
    const { page, rootId, firstId, secondId, thirdId } = createSortableTextPage()
    const restoreRects = installCanvasRects({
      [rootId]: { x: 0, y: 0, width: 400, height: 300 },
      [firstId]: { x: 20, y: 10, width: 160, height: 40 },
      [secondId]: { x: 20, y: 60, width: 160, height: 40 },
      [thirdId]: { x: 20, y: 120, width: 160, height: 40 },
    })
    let raf: ReturnType<typeof installRafQueue> | null = null
    const panCalls: Array<[number, number]> = []

    try {
      render(
        <CanvasActionsTestProvider panBy={(dx, dy) => panCalls.push([dx, dy])}>
          <BreakpointFrame
            page={page}
            breakpoint={{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }}
            isActive
            onActivate={() => {}}
          />
        </CanvasActionsTestProvider>,
      )

      raf = installRafQueue()
      const handle = screen.getByRole('button', { name: 'Drag selected layers' })
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 32, clientY: 64 })
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 196, clientY: 100 })
        raf.flushOne()
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 196, clientY: 100 })
      })

      expect(panCalls.length).toBeGreaterThan(0)
      expect(panCalls[0][0]).toBeLessThan(0)
    } finally {
      raf?.restore()
      restoreRects()
    }
  })
})
