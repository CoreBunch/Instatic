import { describe, expect, it, beforeEach } from 'bun:test'
import React from 'react'
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'fs'
import { useEditorStore } from '@site/store/store'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import {
  getCanvasFrameDocument,
  queryCanvasNodeInFrame,
  waitForCanvasFrameDocument,
  waitForCanvasNodeInFrame,
} from './iframeCanvasQuery'
import '@modules/base'

function renderCanvas() {
  return render(<CanvasRoot />)
}

const BREAKPOINT_FRAME_CSS = new URL(
  '../../admin/pages/site/canvas/BreakpointFrame.module.css',
  import.meta.url,
)

beforeEach(() => {
  cleanup()
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    activePageId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    hasUnsavedChanges: false,
  })
})

describe('canvas breakpoint rendering', () => {
  it('renders the SAME content prop value in every breakpoint frame, even if a stale override exists', () => {
    // Module props (text, tag, src, …) are content — single-value across all
    // breakpoints because the published page is one HTML document. Even if
    // legacy / hand-crafted data carries a per-breakpoint override for a
    // non-responsive prop, the canvas must ignore it so the editor matches
    // what a real visitor will see.
    const site = useEditorStore.getState().createSite('Breakpoint Props')
    const page = site.pages[0]
    const rootId = page.rootNodeId
    const textId = useEditorStore.getState().insertNode('base.text', {
      text: 'Desktop headline',
      tag: 'h1',
    }, rootId)
    // Direct mutation simulating stale data — the Properties Panel and agent
    // executor both reject this kind of write at the boundary now.
    useEditorStore.getState().setBreakpointOverride(textId, 'mobile', {
      text: 'Mobile headline',
    })

    render(
      <BreakpointFrame
        page={useEditorStore.getState().site!.pages[0]}
        breakpoint={{ id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' }}
        isActive
        onActivate={() => {}}
      />,
    )

    // The mobile frame must render the BASE text — never the stale override.
    // The page tree now lives inside the breakpoint's iframe, so `screen`
    // (rooted at document.body) can't see it — query the iframe directly.
    const mobileDoc = getCanvasFrameDocument('mobile')
    expect(mobileDoc).toBeTruthy()
    expect(mobileDoc!.body.textContent).toContain('Desktop headline')
    expect(mobileDoc!.body.textContent).not.toContain('Mobile headline')
  })

  it('selects the clicked node on an inactive breakpoint when no layer is already being edited', async () => {
    const site = useEditorStore.getState().createSite('Breakpoint Selection')
    const page = site.pages[0]
    const textId = useEditorStore.getState().insertNode('base.text', {
      text: 'Shared headline',
      tag: 'h1',
    }, page.rootNodeId)
    useEditorStore.getState().setActiveBreakpoint('desktop')

    renderCanvas()
    const mobileNode = await waitForCanvasNodeInFrame('mobile', textId)

    act(() => {
      fireEvent.click(mobileNode)
    })

    const state = useEditorStore.getState()
    expect(state.activeBreakpointId).toBe('mobile')
    expect(state.selectedNodeId).toBe(textId)
    expect(state.selectedNodeIds).toEqual([textId])
  })

  it('scopes canvas hover to the concrete breakpoint frame under the pointer', async () => {
    const site = useEditorStore.getState().createSite('Breakpoint Hover Scope')
    const page = site.pages[0]
    const textId = useEditorStore.getState().insertNode('base.text', {
      text: 'Shared headline',
      tag: 'h1',
    }, page.rootNodeId)

    renderCanvas()
    const mobileNode = await waitForCanvasNodeInFrame('mobile', textId)
    const desktopNode = await waitForCanvasNodeInFrame('desktop', textId)

    act(() => {
      fireEvent.mouseEnter(mobileNode)
    })

    expect(mobileNode.getAttribute('data-hovered')).toBe('true')
    expect(desktopNode.hasAttribute('data-hovered')).toBe(false)

    act(() => {
      fireEvent.mouseLeave(mobileNode)
      fireEvent.mouseEnter(desktopNode)
    })

    expect(mobileNode.hasAttribute('data-hovered')).toBe(false)
    expect(desktopNode.getAttribute('data-hovered')).toBe('true')
  })

  it('dims inactive breakpoint frames only while editing a selected node in the open properties panel', () => {
    const site = useEditorStore.getState().createSite('Breakpoint Editing Focus')
    const page = site.pages[0]
    const textId = useEditorStore.getState().insertNode('base.text', {
      text: 'Shared headline',
      tag: 'h1',
    }, page.rootNodeId)
    useEditorStore.setState({
      activeBreakpointId: 'tablet',
      selectedNodeId: textId,
      propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
      propertiesPanelMode: 'docked',
    } as Parameters<typeof useEditorStore.setState>[0])

    const { rerender } = render(<CanvasRoot />)

    const tabletFrame = document.querySelector('[data-breakpoint-id="tablet"]')?.parentElement
    const mobileFrame = document.querySelector('[data-breakpoint-id="mobile"]')?.parentElement
    const desktopFrame = document.querySelector('[data-breakpoint-id="desktop"]')?.parentElement

    expect(tabletFrame?.getAttribute('data-breakpoint-dimmed')).toBeNull()
    expect(mobileFrame?.getAttribute('data-breakpoint-dimmed')).toBe('true')
    expect(desktopFrame?.getAttribute('data-breakpoint-dimmed')).toBe('true')

    act(() => {
      useEditorStore.setState({
        propertiesPanel: { collapsed: true, x: 0, y: 0, width: 360 },
      } as Parameters<typeof useEditorStore.setState>[0])
    })
    rerender(<CanvasRoot />)

    expect(mobileFrame?.getAttribute('data-breakpoint-dimmed')).toBeNull()
    expect(desktopFrame?.getAttribute('data-breakpoint-dimmed')).toBeNull()

    const css = readFileSync(BREAKPOINT_FRAME_CSS, 'utf-8')
    expect(css).toContain('.frameWrapperDimmed')
    expect(css).toContain('opacity: 0.42')
  })
})
