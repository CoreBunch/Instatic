import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import {
  queryCanvasNodeInFrame,
  waitForCanvasFrameDocument,
  waitForCanvasNodeInFrame,
} from './iframeCanvasQuery'
import '@modules/base'

afterEach(cleanup)

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeBreakpointId: 'desktop',
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    packageJson: {},
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

describe('canvas breakpoint activation', () => {
  it('activates an inactive breakpoint without changing the selected layer on first node click', async () => {
    renderCanvas()
    await waitForCanvasNodeInFrame('mobile', 'other')
    const otherNode = queryCanvasNodeInFrame('mobile', 'other')
    expect(otherNode).toBeTruthy()

    act(() => {
      fireEvent.click(otherNode!)
    })

    const state = useEditorStore.getState()
    expect(state.activeBreakpointId).toBe('mobile')
    expect(state.selectedNodeId).toBe('selected')
    expect(state.selectedNodeIds).toEqual(['selected'])
  })

  it('shows a cursor-following activation tooltip over inactive breakpoint frames', async () => {
    renderCanvas()
    const mobileDoc = await waitForCanvasFrameDocument('mobile')

    act(() => {
      fireEvent.mouseMove(mobileDoc.body, { clientX: 24, clientY: 32 })
    })

    expect(screen.getByRole('tooltip').textContent).toBe('Click to activate Mobile breakpoint')
  })

  it('does not show the activation tooltip when no layer properties context is active', async () => {
    renderCanvas({ selectedNodeId: null, selectedNodeIds: [] })
    const mobileDoc = await waitForCanvasFrameDocument('mobile')

    act(() => {
      fireEvent.mouseMove(mobileDoc.body, { clientX: 24, clientY: 32 })
    })

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('selects the clicked layer on another breakpoint when the properties panel is not active', async () => {
    renderCanvas({
      selectedNodeId: 'selected',
      selectedNodeIds: ['selected'],
      propertiesPanel: { collapsed: true, x: 0, y: 0, width: 360 },
    })
    await waitForCanvasNodeInFrame('mobile', 'other')
    const otherNode = queryCanvasNodeInFrame('mobile', 'other')
    expect(otherNode).toBeTruthy()

    act(() => {
      fireEvent.click(otherNode!)
    })

    const state = useEditorStore.getState()
    expect(state.activeBreakpointId).toBe('mobile')
    expect(state.selectedNodeId).toBe('other')
    expect(state.selectedNodeIds).toEqual(['other'])
  })
})

function renderCanvas(
  overrides: Partial<ReturnType<typeof useEditorStore.getState>> = {},
) {
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['selected', 'other'] }),
      selected: makeNode({
        id: 'selected',
        moduleId: 'base.text',
        props: { text: 'Selected layer', tag: 'p' },
      }),
      other: makeNode({
        id: 'other',
        moduleId: 'base.text',
        props: { text: 'Other layer', tag: 'p' },
      }),
    },
  })
  const site = makeSite({ pages: [page] })
  act(() => {
    useEditorStore.setState({
      site,
      activePageId: page.id,
      activeDocument: null,
      activeBreakpointId: 'desktop',
      selectedNodeId: 'selected',
      selectedNodeIds: ['selected'],
      ...overrides,
    } as Parameters<typeof useEditorStore.setState>[0])
  })

  render(
    <DndContext>
      <CanvasRoot />
    </DndContext>,
  )
}

