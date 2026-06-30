/**
 * Panels — happy-path unit tests for J6 (DomPanel) and J7+J8 (PropertiesPanel).
 *
 * These tests exercise the store-level logic and the PropertyControlRenderer
 * dispatch table without mounting React components (no jsdom needed).
 */

import { describe, it, expect, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------
import { useEditorStore } from '@site/store/store'

function freshStore() {
  // Reset store to a clean state for each test
  useEditorStore.setState({
    site: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

// ---------------------------------------------------------------------------
// J6: DomPanel — store interactions
// ---------------------------------------------------------------------------

describe('J6 DomPanel — store layer', () => {
  beforeEach(freshStore)

  it('creates a site with a root node and one page', () => {
    const { createSite } = useEditorStore.getState()
    const site = createSite('Test')
    expect(site.pages).toHaveLength(1)
    expect(site.pages[0].title).toBe('Home')
    const page = site.pages[0]
    expect(page.nodes[page.rootNodeId]).toBeDefined()
    expect(page.nodes[page.rootNodeId].moduleId).toBe('base.body')
  })

  it('selectNode updates selectedNodeId in store', () => {
    const state = useEditorStore.getState()
    state.createSite('Test')
    const site = useEditorStore.getState().site!
    const page = site.pages[0]
    const rootId = page.rootNodeId

    useEditorStore.getState().selectNode(rootId)
    expect(useEditorStore.getState().selectedNodeId).toBe(rootId)
  })

  it('insertNode adds child visible in nodes map', () => {
    const { createSite, insertNode } = useEditorStore.getState()
    const site = createSite('Test')
    const page = site.pages[0]
    const nodeId = insertNode('base.text', { text: 'Hello' }, page.rootNodeId)
    const updatedPage = useEditorStore.getState().site!.pages[0]
    expect(updatedPage.nodes[nodeId]).toBeDefined()
    expect(updatedPage.nodes[page.rootNodeId].children).toContain(nodeId)
  })

  it('toggleLeftSidebarPanel("explorer") opens and closes the Explorer panel', () => {
    const state = useEditorStore.getState()
    useEditorStore.setState({ explorerPanelOpen: false } as Parameters<typeof useEditorStore.setState>[0])
    state.toggleLeftSidebarPanel('explorer')
    expect(useEditorStore.getState().explorerPanelOpen).toBe(true)
    useEditorStore.getState().toggleLeftSidebarPanel('explorer')
    expect(useEditorStore.getState().explorerPanelOpen).toBe(false)
  })

  it('cycleFocusedPanel cycles canvas → domTree → properties → canvas', () => {
    const state = useEditorStore.getState()
    // Initial state is canvas
    useEditorStore.setState({ focusedPanel: 'canvas' })
    state.cycleFocusedPanel()
    expect(useEditorStore.getState().focusedPanel).toBe('domTree')
    useEditorStore.getState().cycleFocusedPanel()
    expect(useEditorStore.getState().focusedPanel).toBe('properties')
    useEditorStore.getState().cycleFocusedPanel()
    expect(useEditorStore.getState().focusedPanel).toBe('canvas')
  })
})

// ---------------------------------------------------------------------------
// J6: flattenSubtree — tree traversal
// ---------------------------------------------------------------------------

import { flattenSubtree } from '@core/page-tree'
import type { Page } from '@core/page-tree'

describe('J6 DomPanel — flattenSubtree', () => {
  it('returns just the root when there are no children', () => {
    const page: Page = {
      id: 'p1',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', moduleId: 'base.body', props: {}, children: [], breakpointOverrides: {} },
      },
    }
    expect(flattenSubtree(page, 'root')).toEqual(['root'])
  })

  it('returns nodes in depth-first pre-order', () => {
    const page: Page = {
      id: 'p1',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', moduleId: 'base.body', props: {}, children: ['a', 'b'], breakpointOverrides: {} },
        a: { id: 'a', moduleId: 'base.container', props: {}, children: ['a1'], breakpointOverrides: {} },
        a1: { id: 'a1', moduleId: 'base.text', props: {}, children: [], breakpointOverrides: {} },
        b: { id: 'b', moduleId: 'base.image', props: {}, children: [], breakpointOverrides: {} },
      },
    }
    expect(flattenSubtree(page, 'root')).toEqual(['root', 'a', 'a1', 'b'])
  })
})

// ---------------------------------------------------------------------------
// J7+J8: PropertiesPanel — property condition evaluation
// ---------------------------------------------------------------------------

import { evaluateCondition } from '@core/page-tree'

describe('J7+J8 PropertiesPanel — evaluateCondition', () => {
  const props = { type: 'button', visible: true, count: 3 }

  it('eq: matches equal value', () => {
    expect(evaluateCondition({ field: 'type', eq: 'button' }, props)).toBe(true)
  })

  it('eq: does not match different value', () => {
    expect(evaluateCondition({ field: 'type', eq: 'input' }, props)).toBe(false)
  })

  it('notEq: matches different value', () => {
    expect(evaluateCondition({ field: 'type', notEq: 'input' }, props)).toBe(true)
  })

  it('in: matches when value is in array', () => {
    expect(evaluateCondition({ field: 'type', in: ['button', 'link'] }, props)).toBe(true)
  })

  it('notIn: matches when value is not in array', () => {
    expect(evaluateCondition({ field: 'type', notIn: ['div', 'span'] }, props)).toBe(true)
  })

  it('and: all conditions must be true', () => {
    expect(
      evaluateCondition(
        {
          and: [
            { field: 'type', eq: 'button' },
            { field: 'visible', eq: true },
          ],
        },
        props
      )
    ).toBe(true)
  })

  it('and: fails if any condition is false', () => {
    expect(
      evaluateCondition(
        {
          and: [
            { field: 'type', eq: 'button' },
            { field: 'visible', eq: false },
          ],
        },
        props
      )
    ).toBe(false)
  })

  it('or: passes if any condition is true', () => {
    expect(
      evaluateCondition(
        {
          or: [
            { field: 'type', eq: 'input' },
            { field: 'visible', eq: true },
          ],
        },
        props
      )
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// J7+J8: PropertiesPanel — resolveProps with breakpoint override
// ---------------------------------------------------------------------------

import { resolveProps } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'

describe('J7+J8 PropertiesPanel — resolveProps', () => {
  const node: PageNode = {
    id: 'n1',
    moduleId: 'base.text',
    props: { text: 'Hello', fontSize: 24 },
    children: [],
    breakpointOverrides: {
      mobile: { fontSize: 16 },
    },
  }

  it('returns base props when no breakpoint specified', () => {
    expect(resolveProps(node)).toEqual({ text: 'Hello', fontSize: 24 })
  })

  it('merges breakpoint override when breakpointId matches', () => {
    expect(resolveProps(node, 'mobile')).toEqual({ text: 'Hello', fontSize: 16 })
  })

  it('returns base props when breakpointId has no override', () => {
    expect(resolveProps(node, 'desktop')).toEqual({ text: 'Hello', fontSize: 24 })
  })
})

// ---------------------------------------------------------------------------
// J7+J8: PropertiesPanel — store mutations via Properties panel
// ---------------------------------------------------------------------------

describe('J7+J8 PropertiesPanel — store mutations', () => {
  beforeEach(freshStore)

  it('updateNodeProps patches a node prop immutably', () => {
    const { createSite, insertNode, updateNodeProps } = useEditorStore.getState()
    const site = createSite('Test')
    const page = site.pages[0]
    const nodeId = insertNode('base.text', { text: 'Old' }, page.rootNodeId)

    updateNodeProps(nodeId, { text: 'New' })

    const updatedPage = useEditorStore.getState().site!.pages[0]
    expect(updatedPage.nodes[nodeId].props.text).toBe('New')
    expect(useEditorStore.getState().canUndo).toBe(true)
  })

  it('setBreakpointOverride writes to overrides, not base props', () => {
    const { createSite, insertNode, setBreakpointOverride } = useEditorStore.getState()
    const site = createSite('Test')
    const page = site.pages[0]
    const nodeId = insertNode('base.text', { text: 'Base', fontSize: 24 }, page.rootNodeId)

    setBreakpointOverride(nodeId, 'mobile', { fontSize: 14 })

    const updatedPage = useEditorStore.getState().site!.pages[0]
    const node = updatedPage.nodes[nodeId]
    // Base prop untouched
    expect(node.props.fontSize).toBe(24)
    // Override stored separately
    expect(node.breakpointOverrides['mobile']?.fontSize).toBe(14)
  })

  it('togglePropertiesPanel collapses and expands when a node is selected', () => {
    const { createSite, insertNode, selectNode, togglePropertiesPanel } = useEditorStore.getState()
    const site = createSite('Test')
    const page = site.pages[0]
    const nodeId = insertNode('base.button', { label: 'Button' }, page.rootNodeId)
    selectNode(nodeId)

    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(false)
    togglePropertiesPanel()
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(true)
    useEditorStore.getState().togglePropertiesPanel()
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(false)
  })

  it('selectNode reopens the Properties panel even when selecting the same node again', () => {
    const { createSite, insertNode, selectNode, setPropertiesPanel } = useEditorStore.getState()
    const site = createSite('Test')
    const page = site.pages[0]
    const nodeId = insertNode('base.button', { label: 'Button' }, page.rootNodeId)

    selectNode(nodeId)
    setPropertiesPanel({ collapsed: true })
    expect(useEditorStore.getState().selectedNodeId).toBe(nodeId)
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(true)

    useEditorStore.getState().selectNode(nodeId)

    expect(useEditorStore.getState().selectedNodeId).toBe(nodeId)
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(false)
  })
})
