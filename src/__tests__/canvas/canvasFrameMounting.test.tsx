import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { CanvasTransformLayer } from '@site/canvas/CanvasTransformLayer'
import { CANVAS_VIEWPORT_HEIGHT } from '@site/canvas/resolveViewportUnits'
import { DEFAULT_BREAKPOINTS } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import {
  DEFAULT_MODULE_INSERTER_PREFERENCE,
} from '@core/persistence/userPreferences'
import { __resetModuleInserterPreferenceForTests } from '@site/module-picker/useModuleInserterPreference'
import { makeNode, makePage, makeSite } from '../fixtures'
import {
  getCanvasFrameDocument,
  queryCanvasNodeInFrame,
  waitForCanvasFrameDocument,
  waitForCanvasNodeInFrame,
} from './iframeCanvasQuery'
import '@modules/base'

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
  __resetModuleInserterPreferenceForTests()
})

beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
  __resetModuleInserterPreferenceForTests()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/admin/api/cms/me/preferences/module-inserter')) {
      return new Response(JSON.stringify({ value: DEFAULT_MODULE_INSERTER_PREFERENCE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch

  const rootId = 'root'
  const textId = 'headline'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [textId] }),
      [textId]: makeNode({
        id: textId,
        moduleId: 'base.text',
        props: { text: 'Frame headline', tag: 'h1' },
      }),
    },
  })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    runScripts: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('canvas frame mounting', () => {
  it('mounts every breakpoint frame once the page document is in the store — no staggering', async () => {
    // Render the transform layer directly (this is where the staggering lived)
    // with the page already present. The page tree is in memory, so there is no
    // per-frame stagger: the active frame and every inactive frame mount
    // together. (The previous progressive loader deliberately delayed inactive
    // frames behind a requestAnimationFrame → setTimeout → requestIdleCallback
    // chain, which could strand frames as skeletons if rAF was suspended — a
    // background tab, or a headless CI runner.)
    const page = useEditorStore.getState().site!.pages[0]
    render(
      <CanvasTransformLayer
        page={page}
        breakpoints={DEFAULT_BREAKPOINTS}
        activeBreakpointId="desktop"
        onBreakpointActivate={() => {}}
      />,
    )

    await waitForCanvasNodeInFrame('desktop', 'headline')
    await waitForCanvasNodeInFrame('mobile', 'headline')
    await waitForCanvasNodeInFrame('tablet', 'headline')

    // No skeletons once frames are mounted (the skeleton only renders while
    // `page === null`, exercised by the next test).
    expect(screen.queryByTestId('canvas-frame-skeleton-mobile')).toBeNull()
    expect(screen.queryByTestId('canvas-frame-skeleton-desktop')).toBeNull()
  })

  it('shows skeleton frames while no page document is loaded yet', () => {
    // No active page (the document hasn't loaded) — the canvas renders skeleton
    // frames as the genuine "still loading" affordance, with no node trees.
    useEditorStore.setState({
      site: null,
      activePageId: null,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<CanvasRoot />)

    expect(screen.getByTestId('canvas-frame-skeleton-mobile')).toBeDefined()
    expect(queryCanvasNodeInFrame('mobile', 'headline')).toBeNull()
  })

  it('hides root iframe overflow in design mode but leaves live mode scrollable', async () => {
    render(<CanvasRoot />)

    const designDoc = await waitForCanvasFrameDocument('desktop')
    expect(designDoc.documentElement.style.height).toBe('auto')
    expect(designDoc.body.style.height).toBe('auto')
    expect(designDoc.body.style.minHeight).toBe(`${CANVAS_VIEWPORT_HEIGHT}px`)
    expect(designDoc.documentElement.style.overflow).toBe('hidden')
    expect(designDoc.body.style.overflow).toBe('hidden')

    cleanup()
    useEditorStore.setState({ canvasView: 'live' } as Parameters<typeof useEditorStore.setState>[0])
    render(<CanvasRoot />)

    await flushAnimationFrame()
    const liveDoc = getCanvasFrameDocument('desktop')
    expect(liveDoc).toBeTruthy()
    expect(liveDoc!.body.style.minHeight).toBe('')
    expect(liveDoc!.documentElement.style.overflow).toBe('')
    expect(liveDoc!.body.style.overflow).toBe('')
  })
})
