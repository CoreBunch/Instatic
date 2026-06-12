/**
 * DomPanel DOM integration tests — J6 (Guideline #213 / #221 / #234).
 *
 * Covers:
 *   1. data-testid="dom-panel" / "dom-panel-ready" present (Guideline #221)
 *   2. role="complementary" + aria-label on panel container
 *   3. Empty state text shown when page has only root node
 *   4. Layers skeleton state when site is null
 *   5. data-panel attribute present (event propagation guard, Guideline #192)
 *   6. Toggle button aria-expanded reflects collapsed state
 *   7. Collapse toggle: panel collapses and focus moves to toggle button
 *   8. Tree container has role="tree" when page is loaded
 *   9. Tree node rows have tabIndex=0 and role="treeitem" (Guideline #234)
 *  10. Tree node rows use shared 28px compact TreeRow height
 *  11. Tree node focus ring: boxShadow changes on focus/blur
 *  12. stopPropagation on panel click (Guideline #192)
 *
 * Uses @testing-library/react for all tests — requires the happy-dom GlobalWindow
 * setup from src/__tests__/setup.ts (preloaded via bunfig.toml).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { DomPanel } from '@site/panels/DomPanel/DomPanel'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode, makeVC, makeVCNode, makeVCTree } from '../fixtures'

const TREE_ROW_CSS_PATH = join(import.meta.dir, '../../admin/pages/site/ui/Tree/TreeRow.module.css')
const TREE_DROP_CSS_PATH = join(import.meta.dir, '../../admin/pages/site/ui/Tree/TreeDrop.module.css')
const TREE_NODE_CSS_PATH = join(import.meta.dir, '../../admin/pages/site/panels/DomPanel/TreeNode.module.css')
const TREE_NODE_SOURCE_PATH = join(import.meta.dir, '../../admin/pages/site/panels/DomPanel/TreeNode.tsx')
const DOM_PANEL_SOURCE_PATH = join(import.meta.dir, '../../admin/pages/site/panels/DomPanel/DomPanel.tsx')

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

function resetStore() {
  // Clear localStorage so the panel's restore-on-mount effect doesn't override
  // the store state we set below (the component reads from localStorage on mount).
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    domTreePanel: { collapsed: false, x: 0, y: 0, width: 280 },
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    focusedPanel: 'canvas',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Load a site into the store (simulates opening a site). */
function loadSite(rootHasChildren = false) {
  const rootId = 'root-1'
  const childId = 'node-child-1'

  const nodes: Record<string, ReturnType<typeof makeNode>> = {
    [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: rootHasChildren ? [childId] : [] }),
  }
  if (rootHasChildren) {
    nodes[childId] = makeNode({ id: childId, moduleId: 'base.text', children: [] })
  }

  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes })
  const site = makeSite({ pages: [page] })

  useEditorStore.setState({
    site,
    activePageId: 'page-1',
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadContainerSite() {
  const rootId = 'root-1'
  const containerId = 'container-1'
  const textId = 'text-1'

  const nodes: Record<string, ReturnType<typeof makeNode>> = {
    [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [containerId] }),
    [containerId]: makeNode({ id: containerId, moduleId: 'base.container', children: [textId] }),
    [textId]: makeNode({ id: textId, moduleId: 'base.text', children: [] }),
  }

  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes })
  const site = makeSite({ pages: [page] })

  useEditorStore.setState({
    site,
    activePageId: 'page-1',
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadSiblingContainerSite() {
  const rootId = 'root-1'
  const firstContainerId = 'container-1'
  const firstTextId = 'text-1'
  const secondContainerId = 'container-2'
  const secondTextId = 'text-2'

  const nodes: Record<string, ReturnType<typeof makeNode>> = {
    [rootId]: makeNode({
      id: rootId,
      moduleId: 'base.body',
      children: [firstContainerId, secondContainerId],
    }),
    [firstContainerId]: makeNode({
      id: firstContainerId,
      moduleId: 'base.container',
      children: [firstTextId],
    }),
    [firstTextId]: makeNode({ id: firstTextId, moduleId: 'base.text', children: [] }),
    [secondContainerId]: makeNode({
      id: secondContainerId,
      moduleId: 'base.container',
      children: [secondTextId],
    }),
    [secondTextId]: makeNode({ id: secondTextId, moduleId: 'base.text', children: [] }),
  }

  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes })
  const site = makeSite({ pages: [page] })

  useEditorStore.setState({
    site,
    activePageId: 'page-1',
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadVisualComponentSite() {
  const pageRootId = 'page-root-1'
  const vcRootId = 'vc-root-1'
  const containerId = 'vc-container-1'
  const textId = 'vc-text-1'

  const page = makePage({
    id: 'page-1',
    rootNodeId: pageRootId,
    nodes: {
      [pageRootId]: makeNode({ id: pageRootId, moduleId: 'base.body', children: [] }),
    },
  })
  const vc = makeVC({
    id: 'vc-1',
    name: 'Navigation',
    tree: makeVCTree(vcRootId, [
      makeVCNode({ id: vcRootId, moduleId: 'base.body', children: [containerId] }),
      makeVCNode({ id: containerId, moduleId: 'base.container', children: [textId] }),
      makeVCNode({ id: textId, moduleId: 'base.text', children: [] }),
    ]),
  })

  const site = makeSite({ pages: [page], visualComponents: [vc] })

  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    activeDocument: { kind: 'visualComponent', vcId: 'vc-1' },
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

// ---------------------------------------------------------------------------
// 1 — data-testid (Guideline #221)
// ---------------------------------------------------------------------------

describe('DomPanel — data-testid (Guideline #221)', () => {
  it('renders data-testid="dom-panel" when no site is loaded', () => {
    render(<DomPanel />)
    expect(screen.getByTestId('dom-panel')).toBeDefined()
  })

  it('renders data-testid="dom-panel-ready" once a site/page is loaded', () => {
    loadSite()
    render(<DomPanel />)
    expect(screen.getByTestId('dom-panel-ready')).toBeDefined()
  })

  it('data-testid="dom-panel-tree" present inside loaded panel', () => {
    loadSite(true)
    render(<DomPanel />)
    expect(screen.getByTestId('dom-panel-tree')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 2 — ARIA landmark (role + aria-label)
// ---------------------------------------------------------------------------

describe('DomPanel — ARIA landmark', () => {
  it('has role="complementary" on panel container', () => {
    render(<DomPanel />)
    const panel = screen.getByRole('complementary')
    expect(panel).toBeDefined()
  })

  it('has aria-label="DOM tree panel"', () => {
    render(<DomPanel />)
    const panel = screen.getByLabelText('DOM tree panel')
    expect(panel).toBeDefined()
  })

  it('uses the visible panel landmark as the F6 focus target', async () => {
    useEditorStore.setState({ focusedPanel: 'domTree' } as Parameters<typeof useEditorStore.setState>[0])

    render(<DomPanel />)

    const panel = screen.getByRole('complementary', { name: 'DOM tree panel' })
    await waitFor(() => expect(document.activeElement).toBe(panel))
    expect(panel.getAttribute('aria-hidden')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3 — Empty states
// ---------------------------------------------------------------------------

describe('DomPanel — empty states', () => {
  it('shows a layers skeleton when site is null', () => {
    render(<DomPanel />)
    expect(screen.getByRole('status', { name: 'Loading layers' })).toBeDefined()
    expect(screen.queryByText('Loading site...')).toBeNull()
  })

  it('renders the body root row when the page is empty (always-show invariant)', () => {
    loadSite(false) // only root, no children
    render(<DomPanel />)
    // The empty-state hint is gone — the Body row is always rendered now,
    // matching the always-wrap invariant (every NodeTree's root is base.body).
    expect(screen.queryByText(/no elements yet/i)).toBeNull()
    // The body row is in the tree as a treeitem.
    const treeItems = screen.getAllByRole('treeitem')
    expect(treeItems.length).toBeGreaterThan(0)
  })

  it('renders tree rows when page has child nodes', () => {
    loadSite(true) // root + 1 child
    render(<DomPanel />)
    // Tree rows with role=treeitem should exist
    const treeItems = screen.getAllByRole('treeitem')
    expect(treeItems.length).toBeGreaterThan(0)
  })

  it('hides the structural body root when editing a Visual Component', () => {
    loadVisualComponentSite()
    render(<DomPanel />)

    expect(screen.queryByRole('treeitem', { name: /body/i })).toBeNull()
    const containerRow = screen.getByRole('treeitem', { name: /container/i })
    expect(containerRow.getAttribute('style')).toContain('--tree-row-pl: 8px')
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4 — data-panel attribute (Guideline #192)
// ---------------------------------------------------------------------------

describe('DomPanel — data-panel attribute (Guideline #192)', () => {
  it('panel container carries data-panel attribute for event guard', () => {
    render(<DomPanel />)
    const panel = screen.getByRole('complementary')
    expect(panel.hasAttribute('data-panel')).toBe(true)
  })

  it('click events on the panel do not propagate to parent (stopPropagation)', () => {
    let parentClicked = false
    render(
      <div onClick={() => { parentClicked = true }}>
        <DomPanel />
      </div>
    )
    const panel = screen.getByRole('complementary')
    fireEvent.click(panel)
    expect(parentClicked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5 — Close button (replaced old collapse toggle)
//     Panel now fully hides when collapsed=true — no icon strip.
//     Header shows a close (✕) button that triggers toggleDomTreePanel.
// ---------------------------------------------------------------------------

describe('DomPanel — collapse toggle', () => {
  it('close button is visible when panel is open', () => {
    render(<DomPanel />)
    const btn = screen.getByRole('button', { name: /close layers panel/i })
    expect(btn).toBeDefined()
  })

  it('clicking close button hides the panel (collapsed becomes true, renders null)', () => {
    render(<DomPanel />)
    const btn = screen.getByRole('button', { name: /close layers panel/i })
    fireEvent.click(btn)
    // After closing, the panel root is fully unmounted (collapsed=true → null)
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('panel renders nothing when collapsed=true (fully closed, no icon strip)', () => {
    useEditorStore.setState({
      domTreePanel: { collapsed: true, x: 0, y: 0, width: 280 },
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<DomPanel />)
    // Panel is fully unmounted — no complementary landmark or strip
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('"Layers" heading is visible when panel is expanded', () => {
    render(<DomPanel />)
    expect(screen.getByText('Layers')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 6 — Tree accessibility (role="tree", role="treeitem", tabIndex, minHeight)
// ---------------------------------------------------------------------------

describe('DomPanel — tree accessibility', () => {
  it('tree container has role="tree" (WAI-ARIA tree pattern)', () => {
    loadSite(true)
    render(<DomPanel />)
    const tree = screen.getByRole('tree')
    expect(tree).toBeDefined()
  })

  it('tree has aria-label="Page element tree"', () => {
    loadSite(true)
    render(<DomPanel />)
    const tree = screen.getByRole('tree')
    expect(tree.getAttribute('aria-label')).toBe('Page element tree')
  })

  it('tree node rows have role="treeitem" (Guideline #234)', () => {
    loadSite(true)
    render(<DomPanel />)
    const items = screen.getAllByRole('treeitem')
    expect(items.length).toBeGreaterThan(0)
  })

  it('tree node rows have tabIndex=0 for keyboard navigation', () => {
    loadSite(true)
    render(<DomPanel />)
    const items = screen.getAllByRole('treeitem')
    for (const item of items) {
      expect(item.getAttribute('tabindex')).toBe('0')
    }
  })

  it('tree node rows have compact height of 28px by default (Guideline #357 — compact density)', () => {
    // Guideline #357 (user directive #1532): WCAG 2.5.5 touch target requirement
    // is explicitly waived for editor chrome. Default row height is 28px for
    // compact density. The `density` user preference can override to 36px via
    // a CSS variable on the editor root, but the default contract still has to
    // resolve to 28px when no density attribute is present.
    // (CSS Modules are not injected into happy-dom, so DOM class checks are unreliable).
    const css = readFileSync(TREE_ROW_CSS_PATH, 'utf8')
    // The .row block declares `--tree-row-h: 28px` as the compact default and
    // applies it via `height: var(--tree-row-h)`. Both halves must be present.
    const hasCompactDefault = /\.row\s*\{[^}]*--tree-row-h:\s*28px/s.test(css)
    const hasHeightFromVar = /\.row\s*\{[^}]*height:\s*var\(--tree-row-h\)/s.test(css)
    expect(hasCompactDefault).toBe(true)
    expect(hasHeightFromVar).toBe(true)
  })

  it('drop indicators are CSS overlays that do not change tree row height', () => {
    const css = readFileSync(TREE_DROP_CSS_PATH, 'utf8')

    expect(css).toContain('.dropBefore::before')
    expect(css).toContain('.dropAfter::after')
    expect(css).toContain('position: absolute')

    const beforeAfterBlocks = css.match(/\.dropBefore::before,\n\.dropAfter::after\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(beforeAfterBlocks).not.toMatch(/(?:^|\n)\s*(height:\s*(?:2[89]|[3-9]\d)px|margin|padding)\b/)

    const insideBlock = css.match(/\.dropInside\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(insideBlock).toContain('outline')
    expect(insideBlock).not.toMatch(/(?:^|\n)\s*(height|margin|padding)\b/)
  })

  it('DOM tree nodes consume the shared tree drop helpers', () => {
    const source = readFileSync(TREE_NODE_SOURCE_PATH, 'utf8')

    expect(source).toContain('treeDropStyles')
    expect(source).toContain('treeDropStyles.dropBefore')
    expect(source).toContain('treeDropStyles.dropAfter')
    expect(source).toContain('treeDropStyles.dropInside')
    expect(source).toContain('treeDropStyles.dropInvalid')
  })

  it('drag overlay is portaled outside the transformed panel to keep pointer alignment', () => {
    const source = readFileSync(DOM_PANEL_SOURCE_PATH, 'utf8')

    expect(source).toContain('createPortal')
    expect(source).toContain('document.body')
    expect(source).toMatch(/createPortal\(\s*dragOverlay/s)
  })

  it('does not suppress DOM panel drag commits while editing a Visual Component', () => {
    const source = readFileSync(DOM_PANEL_SOURCE_PATH, 'utf8')

    expect(source).not.toContain("startsWith('vc-virtual:')")
    expect(source).not.toContain('wire DnD reordering inside VC mode')
  })

  it('selected tree node has aria-selected="true"', () => {
    loadSite(true)
    // Select the root node (root is always visible regardless of expand state).
    // Multi-select: keep `selectedNodeId` and `selectedNodeIds` in sync — the
    // per-row `isSelected` selector reads `selectedNodeIds.includes(nodeId)`.
    useEditorStore.setState({ selectedNodeId: 'root-1', selectedNodeIds: ['root-1'] } as Parameters<typeof useEditorStore.setState>[0])
    render(<DomPanel />)
    const selected = screen.getByRole('treeitem', { selected: true })
    expect(selected).toBeDefined()
  })

  it('unselected tree node has aria-selected="false"', () => {
    loadSite(true)
    useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
    render(<DomPanel />)
    const items = screen.getAllByRole('treeitem')
    // All items should have aria-selected=false when nothing selected
    for (const item of items) {
      expect(item.getAttribute('aria-selected')).toBe('false')
    }
  })
})

// ---------------------------------------------------------------------------
// 7 — Open container group highlight
// ---------------------------------------------------------------------------

describe('DomPanel — open container group highlight', () => {
  it('marks the whole expanded container wrapper as an open group', () => {
    loadContainerSite()
    render(<DomPanel />)

    const rootItem = screen.getByRole('treeitem', { name: /body/i })
    fireEvent.click(rootItem)

    const containerWrapper = document.querySelector('[data-node-id="container-1"]')
    expect(containerWrapper?.getAttribute('data-open-container-group')).toBeNull()

    const containerItem = screen.getByRole('treeitem', { name: /container/i })
    fireEvent.click(containerItem)

    expect(containerWrapper?.getAttribute('data-open-container-group')).toBe('true')
  })

  it('styles open container groups with a rounded background on the wrapper', () => {
    const source = readFileSync(TREE_NODE_SOURCE_PATH, 'utf8')
    const rowCss = readFileSync(TREE_ROW_CSS_PATH, 'utf8')
    const css = readFileSync(TREE_NODE_CSS_PATH, 'utf8')

    expect(source).toContain('styles.openContainerGroup')
    expect(css).toContain('.openContainerGroup')

    const rowBlock = rowCss.match(/\.row\s*\{[^}]*\}/s)?.[0] ?? ''
    const block = css.match(/\.openContainerGroup\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(block).toContain('background:')
    expect(rowBlock).toMatch(/border-radius:\s*8px/)
    expect(block).toMatch(/border-radius:\s*8px/)
    expect(block).not.toContain('18px')
  })

  it('moves the open group highlight when selecting a different expanded container', () => {
    loadSiblingContainerSite()
    render(<DomPanel />)

    fireEvent.click(screen.getByRole('treeitem', { name: /body/i }))

    const firstWrapper = document.querySelector('[data-node-id="container-1"]')
    const secondWrapper = document.querySelector('[data-node-id="container-2"]')

    const containerItems = screen.getAllByRole('treeitem', { name: /container/i })
    fireEvent.click(containerItems[0])

    expect(firstWrapper?.getAttribute('data-open-container-group')).toBe('true')
    expect(secondWrapper?.getAttribute('data-open-container-group')).toBeNull()

    fireEvent.click(containerItems[1])

    expect(firstWrapper?.getAttribute('data-open-container-group')).toBeNull()
    expect(secondWrapper?.getAttribute('data-open-container-group')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// 8 — Keyboard navigation in tree rows
// ---------------------------------------------------------------------------

describe('DomPanel — tree keyboard navigation', () => {
  it('pressing Enter on a tree row selects the node', () => {
    loadSite(true)
    useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
    render(<DomPanel />)
    // Root is always the first (and only top-level) treeitem visible
    const items = screen.getAllByRole('treeitem')
    const rootItem = items[0]

    fireEvent.keyDown(rootItem, { key: 'Enter' })
    expect(useEditorStore.getState().selectedNodeId).toBe('root-1')
  })

  it('pressing Space on a tree row selects the node', () => {
    loadSite(true)
    useEditorStore.setState({ selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
    render(<DomPanel />)
    const items = screen.getAllByRole('treeitem')
    const rootItem = items[0]

    fireEvent.keyDown(rootItem, { key: ' ' })
    expect(useEditorStore.getState().selectedNodeId).toBe('root-1')
  })

  it('page root is always rendered expanded — its children are visible without toggling', () => {
    // The root row is the implicit body injected into every editor: it is
    // forced open and exposes no chevron, so children are visible immediately.
    loadSite(true)
    render(<DomPanel />)

    // Root + its single child should both be visible from the first paint.
    expect(screen.getAllByRole('treeitem').length).toBe(2)
  })

  it('page root row exposes no aria-expanded — it is not collapsible', () => {
    loadSite(true)
    render(<DomPanel />)
    const rootItem = screen.getAllByRole('treeitem')[0]
    // aria-expanded is omitted entirely (not "true"/"false") because the row
    // has no expand/collapse affordance.
    expect(rootItem.hasAttribute('aria-expanded')).toBe(false)
  })

  it('clicking a non-root parent row expands its children like the Files tree', () => {
    loadContainerSite()
    render(<DomPanel />)

    // Root is always expanded → root + container are visible, but the
    // container's text child is collapsed by default.
    expect(screen.getAllByRole('treeitem').length).toBe(2)

    const containerItem = screen.getByRole('treeitem', { name: /container/i })
    fireEvent.click(containerItem)

    expect(screen.getAllByRole('treeitem').length).toBe(3)
    expect(useEditorStore.getState().selectedNodeId).toBe('container-1')
  })

  it('expanding two sibling containers is independent — each retains its own expanded state', () => {
    // Validates the ExpansionStore refactor: per-node useSyncExternalStore
    // subscriptions mean toggling node A must not collapse or affect node B.
    loadSiblingContainerSite()
    render(<DomPanel />)

    // root + container-1 + container-2 visible; both containers collapsed
    expect(screen.getAllByRole('treeitem').length).toBe(3)

    // Expand container-1 — should show its text child
    const containerItems = screen.getAllByRole('treeitem', { name: /container/i })
    fireEvent.click(containerItems[0])
    expect(screen.getAllByRole('treeitem').length).toBe(4) // root + c1 + text-1 + c2

    // Expand container-2 — container-1 must REMAIN expanded (text-1 still visible)
    const containerItemsNow = screen.getAllByRole('treeitem', { name: /container/i })
    fireEvent.click(containerItemsNow[1])
    expect(screen.getAllByRole('treeitem').length).toBe(5) // root + c1 + text-1 + c2 + text-2
  })

  it('commits inline tree rename to the node label', () => {
    loadContainerSite()
    render(<DomPanel />)

    fireEvent.click(screen.getByRole('treeitem', { name: /body/i }))
    const containerItem = screen.getByRole('treeitem', { name: /container/i })

    fireEvent.contextMenu(containerItem, { clientX: 40, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))
    const input = screen.getByRole('textbox', {
      name: /rename (base\.container|container)/i,
    }) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Hero Group' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const renamedNode = useEditorStore.getState().site?.pages[0].nodes['container-1']
    expect(renamedNode?.label).toBe('Hero Group')
    expect(renamedNode?.props.label).toBeUndefined()
    expect(screen.getByRole('treeitem', { name: /hero group/i })).toBeDefined()
  })

  it('opens inline tree rename from a double-clicked layer row', () => {
    loadContainerSite()
    render(<DomPanel />)

    const containerItem = screen.getByRole('treeitem', { name: /container/i })
    fireEvent.doubleClick(containerItem)

    expect(screen.getByRole('textbox', {
      name: /rename (base\.container|container)/i,
    })).toBeDefined()
  })

  it('keeps hidden nodes in the tree and marks them with a hidden badge', () => {
    loadContainerSite()
    act(() => {
      useEditorStore.getState().toggleNodeHidden('container-1')
    })

    render(<DomPanel />)

    expect(screen.getByRole('treeitem', { name: /container, hidden/i })).toBeDefined()
    expect(screen.getByText('hidden')).toBeDefined()
  })
})
