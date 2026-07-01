import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import {
  waitForCanvasFrameDocument,
  waitForCanvasNodeInFrame,
} from './iframeCanvasQuery'
import '@modules/base'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

beforeEach(() => {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    clipboardEntry: null,
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

describe('canvas body context menu', () => {
  it('opens the root insert menu from an empty iframe body background', async () => {
    seedClipboardAndActivateEmptyPage()

    render(
      <DndContext>
        <CanvasRoot />
      </DndContext>,
    )

    const desktopDoc = await waitForCanvasFrameDocument('desktop')
    await waitForCanvasNodeInFrame('desktop', 'empty-root')

    act(() => {
      fireEvent.contextMenu(desktopDoc.body, { clientX: 80, clientY: 96 })
    })

    await waitFor(() => {
      expect(screen.getByRole('menu', { name: 'Node options' })).toBeDefined()
    })
    expect(screen.getByRole('menuitem', { name: /insert module here/i })).toBeDefined()
    const pasteItem = screen.getByRole('menuitem', { name: /^paste$/i })
    expect(screen.getByRole('menuitem', { name: /paste html here/i })).toBeDefined()

    const state = useEditorStore.getState()
    expect(state.selectedNodeId).toBe('empty-root')
    expect(state.selectedNodeIds).toEqual(['empty-root'])

    fireEvent.click(pasteItem)

    const page = useEditorStore.getState().site?.pages.find((candidate) => candidate.id === 'page-empty')
    const root = page?.nodes['empty-root']
    expect(root?.children.length).toBe(1)
    const pastedId = root?.children[0]
    const pasted = pastedId ? page?.nodes[pastedId] : null
    expect(pasted?.moduleId).toBe('base.text')
    expect(pastedId).not.toBe('clip-text')
  })
})

function seedClipboardAndActivateEmptyPage() {
  const sourcePage = makePage({
    id: 'page-source',
    title: 'Source',
    slug: 'source',
    rootNodeId: 'source-root',
    nodes: {
      'source-root': makeNode({ id: 'source-root', moduleId: 'base.body', children: ['clip-text'] }),
      'clip-text': makeNode({
        id: 'clip-text',
        moduleId: 'base.text',
        props: { text: 'Copied text', tag: 'p' },
      }),
    },
  })
  const emptyPage = makePage({
    id: 'page-empty',
    title: 'Empty',
    slug: 'empty',
    rootNodeId: 'empty-root',
    nodes: {
      'empty-root': makeNode({ id: 'empty-root', moduleId: 'base.body', children: [] }),
    },
  })

  act(() => {
    useEditorStore.setState({
      site: makeSite({ pages: [sourcePage, emptyPage] }),
      activePageId: sourcePage.id,
      activeDocument: null,
      activeBreakpointId: 'desktop',
      selectedNodeId: null,
      selectedNodeIds: [],
    } as Parameters<typeof useEditorStore.setState>[0])
  })

  expect(useEditorStore.getState().cutNode('clip-text')).toBe(true)
  act(() => {
    useEditorStore.setState({
      activePageId: emptyPage.id,
      selectedNodeId: null,
      selectedNodeIds: [],
    } as Parameters<typeof useEditorStore.setState>[0])
  })
  expect(useEditorStore.getState().clipboardEntry).not.toBeNull()
}
