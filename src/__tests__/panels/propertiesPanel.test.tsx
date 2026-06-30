/**
 * PropertiesPanel DOM integration tests — J7+J8 (Guideline #213 / #221 / #220).
 *
 * Covers:
 *   1. data-testid="properties-panel" present (Guideline #221)
 *   2. role="complementary" + aria-label="Properties" on panel container
 *   3. data-panel attribute (event propagation guard, Guideline #192)
 *   4. Panel closes itself when no node is selected
 *   5. Controls render for selected node based on module schema
 *   6. Header rename renders an uncontrolled input (defaultValue, not value — Guideline #220)
 *   7. Header close button collapses the panel with no icon strip
 *   8. Breakpoint override hint shown when non-desktop breakpoint is active
 *   9. Property control wrappers have data-testid="property-control-{key}" (Guideline #221)
 *
 * Uses @testing-library/react. The happy-dom GlobalWindow setup is preloaded via
 * bunfig.toml before this file runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { useEditorStore } from '@site/store/store'
import { registry } from '@core/module-engine'
import { makeSite, makePage, makeNode } from '../fixtures'
// Register all base modules so registry.get() works during tests
import '@modules/base/index'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

function resetStore() {
  // Clear localStorage to prevent the panel's restore-on-mount effect from
  // overriding the state we set (component reads from localStorage on mount).
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
// SiteDocument / node setup helpers
// ---------------------------------------------------------------------------

/**
 * Load a site with one page that contains a text node.
 * Returns the node ID for use in tests.
 */
function loadSiteWithHeading(): { nodeId: string; rootId: string } {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const textNode = makeNode({ id: nodeId, moduleId: 'base.text', props: { text: 'Hello', tag: 'h2' }, children: [] })
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: rootNode, [nodeId]: textNode } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  return { nodeId, rootId }
}

function loadSiteWithHeadingAndButton(): { headingId: string; buttonId: string; rootId: string } {
  const rootId = 'root-1'
  const headingId = 'text-1'
  const buttonId = 'button-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [buttonId, headingId] })
  const buttonNode = makeNode({ id: buttonId, moduleId: 'base.button', props: { label: 'Click me' }, children: [] })
  const headingNode = makeNode({ id: headingId, moduleId: 'base.text', props: { text: 'Hello', tag: 'h2' }, children: [] })
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: rootNode,
      [buttonId]: buttonNode,
      [headingId]: headingNode,
    },
  })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  return { headingId, buttonId, rootId }
}

function selectNode(nodeId: string) {
  useEditorStore.setState({ selectedNodeId: nodeId } as Parameters<typeof useEditorStore.setState>[0])
}

// ---------------------------------------------------------------------------
// 1 — data-testid (Guideline #221)
// ---------------------------------------------------------------------------

describe('PropertiesPanel — data-testid (Guideline #221)', () => {
  it('renders data-testid="properties-panel"', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    expect(screen.getByTestId('properties-panel')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 2 — ARIA landmark (role + aria-label)
// ---------------------------------------------------------------------------

describe('PropertiesPanel — ARIA landmark', () => {
  it('has role="complementary" on panel container', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    // There may be multiple complementary elements (DomPanel also has one), but
    // we select by label to be precise.
    const panel = screen.getByRole('complementary', { name: 'Properties' })
    expect(panel).toBeDefined()
  })

  it('has aria-label="Properties"', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    const panel = screen.getByLabelText('Properties')
    expect(panel).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 3 — data-panel attribute (Guideline #192)
// ---------------------------------------------------------------------------

describe('PropertiesPanel — data-panel + stopPropagation', () => {
  it('carries data-panel attribute for event propagation guard', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    const panel = screen.getByTestId('properties-panel')
    expect(panel.hasAttribute('data-panel')).toBe(true)
  })

  it('click events on the panel do NOT propagate to parent (Guideline #192)', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    let parentClicked = false
    render(
      <div onClick={() => { parentClicked = true }}>
        <PropertiesPanel />
      </div>
    )
    const panel = screen.getByTestId('properties-panel')
    fireEvent.click(panel)
    expect(parentClicked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4 — Empty states
// ---------------------------------------------------------------------------

describe('PropertiesPanel — empty states', () => {
  it('closes itself instead of showing an empty prompt when no node is selected', () => {
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('properties-panel')).toBeNull()
    expect(screen.queryByText(/select an element/i)).toBeNull()
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(true)
  })

  it('stays closed when a site is loaded but nothing selected', () => {
    loadSiteWithHeading()
    // selectedNodeId remains null
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('properties-panel')).toBeNull()
    expect(screen.queryByText(/select an element/i)).toBeNull()
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(true)
  })

  it('closes itself when the selected node is deselected', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)

    expect(screen.getByTestId('properties-panel')).toBeDefined()

    act(() => {
      useEditorStore.getState().clearSelection()
    })

    expect(screen.queryByTestId('properties-panel')).toBeNull()
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5 — Controls rendered for selected node
// ---------------------------------------------------------------------------

describe('PropertiesPanel — controls for selected node', () => {
  it('shows controls when a node with a registered module is selected', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    // Should NOT show empty state
    expect(screen.queryByText(/select an element/i)).toBeNull()
  })

  it('renders selected element name in the panel header without module id badge', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    expect(screen.getByRole('button', { name: /rename text/i })).toBeDefined()
    expect(screen.queryByText('base.text')).toBeNull()
  })

  it('renders property control wrappers with data-testid="property-control-{key}" (Guideline #221)', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    // base.text has at least a "text" schema property
    const headingDef = registry.get('base.text')
    if (headingDef) {
      const firstKey = Object.keys(headingDef.schema)[0]
      expect(screen.getByTestId(`property-control-${firstKey}`)).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// 6 — Header rename: uncontrolled input (Guideline #220)
// ---------------------------------------------------------------------------

describe('PropertiesPanel — header rename uncontrolled input (Guideline #220)', () => {
  it('element name input uses defaultValue (not value) — uncontrolled pattern', async () => {
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      new URL('../../admin/pages/site/panels/PropertiesPanel/NodeHeader.tsx', import.meta.url),
      'utf-8'
    )
    // NodeHeader uses defaultValue for the inline label editor
    expect(src).toContain('defaultValue={displayName}')
    // Must NOT use controlled value= on the element name input
    // (we accept value= only if it's inside a JSX expression for a non-label control)
    const nodeHeaderSection = src.match(/function NodeHeader[\s\S]*?^}/m)?.[0] ?? src
    expect(nodeHeaderSection).not.toMatch(/\bvalue=\{label/)
  })

  it('blurring element name input with new value calls renameNode', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /rename text/i }))
    const input = screen.getByRole('textbox', { name: /element name/i }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'New Name' } })
    fireEvent.blur(input)

    // renameNode should have updated the store
    const store = useEditorStore.getState()
    const page = store.site!.pages[0]
    expect(page.nodes[nodeId].label).toBe('New Name')
  })

  it('pressing Escape on the label input reverts its value', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /rename text/i }))
    const input = screen.getByRole('textbox', { name: /element name/i }) as HTMLInputElement
    const originalValue = input.value
    fireEvent.change(input, { target: { value: 'Interim Value' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    // After Escape, the input value should be restored to the original
    expect(input.value).toBe(originalValue)
  })

  it('updates the label input when selecting a different node while the panel stays open', () => {
    const { headingId, buttonId } = loadSiteWithHeadingAndButton()
    selectNode(buttonId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /rename button/i }))
    const input = screen.getByRole('textbox', { name: /element name/i }) as HTMLInputElement
    expect(input.value).toBe('Button')
    expect(screen.queryByText('base.button')).toBeNull()

    act(() => {
      useEditorStore.getState().selectNode(headingId)
    })

    expect(screen.getByRole('button', { name: /rename text/i })).toBeDefined()
    expect(screen.queryByText('base.text')).toBeNull()
  })

  it('pressing Enter on the label input blurs it (commits)', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /rename text/i }))
    const input = screen.getByRole('textbox', { name: /element name/i }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Committed Name' } })
    // Enter calls input.blur() imperatively; happy-dom requires an explicit fireEvent.blur
    // to trigger React's synthetic onBlur handler.
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)

    // onBlur → renameNode should have committed the value
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].label).toBe('Committed Name')
  })
})

// ---------------------------------------------------------------------------
// 7 — Close button (replaced old collapse toggle)
//     Panel now fully hides when collapsed=true — no icon strip.
//     Header shows a close (✕) button that triggers togglePropertiesPanel.
// ---------------------------------------------------------------------------

describe('PropertiesPanel — close button', () => {
  it('close button is visible when panel is open', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    const btn = screen.getByRole('button', { name: /close properties panel/i })
    expect(btn).toBeDefined()
  })

  it('clicking close button hides the panel (collapsed becomes true, renders null)', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    const btn = screen.getByRole('button', { name: /close properties panel/i })
    fireEvent.click(btn)
    // After closing, the panel root is fully unmounted (collapsed=true → null)
    expect(screen.queryByTestId('properties-panel')).toBeNull()
  })

  it('panel renders nothing when collapsed=true (fully closed, no icon strip)', () => {
    useEditorStore.setState({
      propertiesPanel: { collapsed: true, x: 0, y: 0, width: 280 },
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<PropertiesPanel />)
    // Panel is fully unmounted — neither data-testid nor any fallback strip
    expect(screen.queryByTestId('properties-panel')).toBeNull()
  })

  it('Properties header keeps the semantic toolbar name when panel is open', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    expect(screen.getByRole('toolbar', { name: /properties panel header/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 8 — Breakpoint override indicator
//
// The previous "editing tablet" text hint was replaced by a breakpoint dot
// indicator on the Module section header (Spec PP-13). The indicator-shape
// assertions live in `propertiesPanel-redesign.test.tsx`; the stale text
// affordance no longer exists, so there is nothing to check here.
// ---------------------------------------------------------------------------
