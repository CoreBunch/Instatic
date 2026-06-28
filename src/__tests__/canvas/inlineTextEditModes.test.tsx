import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { useEditorStore } from '@site/store/store'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { waitForCanvasNodeInFrame } from './iframeCanvasQuery'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function renderCanvas() {
  return render(
    <DndContext>
      <CanvasRoot />
    </DndContext>,
  )
}

function setupTextPage() {
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['heading'] })
  const heading = makeNode({
    id: 'heading',
    moduleId: 'base.text',
    props: { text: 'Edit me', tag: 'h1' },
  })
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: { root, heading },
  })

  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    selectedNodeId: null,
    selectedNodeIds: [],
    propertiesPanelMode: 'docked',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    hoveredNodeId: null,
    activeInlineEdit: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  cleanup()
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ value: null }), { status: 200 })) as typeof fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    canvasView: 'design',
    activeInlineEdit: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('inline text edit across canvas modes', () => {
  it('starts a session on double-click in live mode', async () => {
    setupTextPage()
    useEditorStore.setState({ canvasView: 'live', activeBreakpointId: 'mobile' } as Parameters<
      typeof useEditorStore.setState
    >[0])
    renderCanvas()

    const headingEl = await waitForCanvasNodeInFrame('mobile', 'heading')
    fireEvent.doubleClick(headingEl)

    const session = useEditorStore.getState().activeInlineEdit
    expect(session?.nodeId).toBe('heading')
    expect(session?.breakpointId).toBe('mobile')
    expect(headingEl.getAttribute('contenteditable')).toBe('plaintext-only')
  })

  it('starts a session on double-click in an inactive mobile frame while desktop is active', async () => {
    setupTextPage()
    useEditorStore.getState().selectNode('heading')
    renderCanvas()

    const mobileHeading = await waitForCanvasNodeInFrame('mobile', 'heading')
    fireEvent.doubleClick(mobileHeading)

    const state = useEditorStore.getState()
    expect(state.activeBreakpointId).toBe('mobile')
    expect(state.selectedNodeId).toBe('heading')
    expect(state.activeInlineEdit?.breakpointId).toBe('mobile')
    expect(mobileHeading.getAttribute('contenteditable')).toBe('plaintext-only')
  })

  it('starts inline edit from Enter in live mode', async () => {
    setupTextPage()
    useEditorStore.setState({ canvasView: 'live', activeBreakpointId: 'tablet' } as Parameters<
      typeof useEditorStore.setState
    >[0])
    renderCanvas()

    const headingEl = await waitForCanvasNodeInFrame('tablet', 'heading')
    await act(async () => {
      fireEvent.click(headingEl)
    })

    const canvasRoot = document.querySelector('[data-testid="canvas-root"]') as HTMLElement
    fireEvent.keyDown(canvasRoot, { key: 'Enter', code: 'Enter' })

    expect(useEditorStore.getState().activeInlineEdit?.breakpointId).toBe('tablet')
    expect(headingEl.getAttribute('contenteditable')).toBe('plaintext-only')
  })
})
