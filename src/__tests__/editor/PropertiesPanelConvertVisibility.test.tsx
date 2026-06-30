/**
 * PropertiesPanelConvertVisibility — ConvertToComponentButton visibility smoke tests
 *
 * These tests verify that `ConvertToComponentButton` is shown / hidden according
 * to the gating conditions in PropertiesPanel.tsx:
 *
 *   activeDocument?.kind !== 'visualComponent'   &&
 *   selectedNode.moduleId !== 'base.body'         &&
 *   selectedNode.moduleId !== 'base.visual-component-ref'
 *
 * PPVC-1  No selection → button NOT in document
 * PPVC-2  Selected node is base.body → button NOT in document
 * PPVC-3  Selected node is base.visual-component-ref → button NOT in document
 * PPVC-4  Active document is a VC (kind === 'visualComponent') → button NOT in document
 * PPVC-5  Selected non-root, non-ref node on a page → button IS in document
 *
 * @see src/editor/components/PropertiesPanel/PropertiesPanel.tsx
 * @see src/editor/components/PropertiesPanel/ConvertToComponentButton.tsx
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { useEditorStore } from '@site/store/store'
import type { VisualComponent, VCNode } from '@core/visualComponents'
import { makeSite, makePage, makeNode } from '../fixtures'

// Register base modules so registry.get() resolves module definitions in-test
import '@modules/base/index'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    focusedPanel: 'canvas',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

// ---------------------------------------------------------------------------
// PPVC-1 — no selection → panel hidden → button not in document
// ---------------------------------------------------------------------------

describe('PPVC-1 — no selection → Convert button not present', () => {
  it('button is absent when selectedNodeId is null', () => {
    // No site, no selection
    render(<PropertiesPanel />)
    expect(
      screen.queryByRole('button', { name: /Componentize/i }),
    ).toBeNull()
  })

  it('button is absent when a site is loaded but no node selected', () => {
    const rootNode = makeNode({ id: 'root-1', moduleId: 'base.body', children: [] })
    const page = makePage({ id: 'page-1', rootNodeId: 'root-1', nodes: { 'root-1': rootNode } })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({
      site,
      activePageId: 'page-1',
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PropertiesPanel />)
    expect(
      screen.queryByRole('button', { name: /Componentize/i }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PPVC-2 — selected root node → button NOT in document
// ---------------------------------------------------------------------------

describe('PPVC-2 — root node selected → Convert button not present', () => {
  it('button is absent when selectedNode.moduleId === "base.body"', () => {
    const rootId = 'root-1'
    const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [] })
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: { [rootId]: rootNode },
    })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({
      site,
      activePageId: 'page-1',
      selectedNodeId: rootId,
      propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PropertiesPanel />)

    expect(
      screen.queryByRole('button', { name: /Componentize/i }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PPVC-3 — VC-ref node selected → button NOT in document
// ---------------------------------------------------------------------------

describe('PPVC-3 — base.visual-component-ref selected → Convert button not present', () => {
  it('button is absent when selectedNode.moduleId === "base.visual-component-ref"', () => {
    const rootId = 'root-1'
    const refId = 'ref-1'
    const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [refId] })
    const refNode = makeNode({
      id: refId,
      moduleId: 'base.visual-component-ref',
      props: { componentId: 'vc-some', propOverrides: {}, slotContent: {} },
      children: [],
    })
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: { [rootId]: rootNode, [refId]: refNode },
    })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({
      site,
      activePageId: 'page-1',
      selectedNodeId: refId,
      propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PropertiesPanel />)

    expect(
      screen.queryByRole('button', { name: /Componentize/i }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PPVC-4 — activeDocument is a VC → button NOT in document
// ---------------------------------------------------------------------------

describe('PPVC-4 — VC canvas mode → Convert button not present', () => {
  it('button is absent when activeDocument.kind === "visualComponent"', () => {
    // Build a VC with a text node inside it so the panel has something to inspect
    const textVCNode: VCNode = {
      id: 'text-in-vc',
      moduleId: 'base.text',
      props: { text: 'Hello', tag: 'p' },
      breakpointOverrides: {},
      children: [],
      classIds: [],
    }
    const vcRootNode: VCNode = {
      id: 'vc-root',
      moduleId: 'base.body',
      props: {},
      breakpointOverrides: {},
      children: ['text-in-vc'],
      classIds: [],
    }
    const vc: VisualComponent = {
      id: 'vc-1',
      name: 'TestVC',
      tree: {
        rootNodeId: 'vc-root',
        nodes: { 'vc-root': vcRootNode, 'text-in-vc': textVCNode },
      },
      params: [],
      breakpoints: [],
      classIds: [],
      createdAt: Date.now(),
    }

    const site = makeSite({ visualComponents: [vc] })
    useEditorStore.setState({
      site,
      activePageId: null,
      activeDocument: { kind: 'visualComponent', vcId: 'vc-1' },
      // Select the text node inside the VC so the panel shows module controls
      selectedNodeId: 'text-in-vc',
      propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PropertiesPanel />)

    // The panel should be open (selectedNodeId is set) but the button must NOT appear
    expect(
      screen.queryByRole('button', { name: /Componentize/i }),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PPVC-5 — non-root, non-ref node on a page → button IS in document
// ---------------------------------------------------------------------------

describe('PPVC-5 — regular node on page → Convert button present', () => {
  it('button IS present for a non-root, non-ref node when in page canvas mode', () => {
    const rootId = 'root-1'
    const nodeId = 'text-1'
    const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
    const textNode = makeNode({
      id: nodeId,
      moduleId: 'base.text',
      props: { text: 'Hello', tag: 'p' },
      children: [],
    })
    const page = makePage({
      id: 'page-1',
      rootNodeId: rootId,
      nodes: { [rootId]: rootNode, [nodeId]: textNode },
    })
    const site = makeSite({ pages: [page] })
    useEditorStore.setState({
      site,
      activePageId: 'page-1',
      // activeDocument: null means page canvas mode — condition reads activeDocument?.kind !== 'visualComponent' → true
      activeDocument: null,
      selectedNodeId: nodeId,
      propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PropertiesPanel />)

    expect(
      screen.getByRole('button', { name: /Componentize/i }),
    ).toBeDefined()
  })
})
