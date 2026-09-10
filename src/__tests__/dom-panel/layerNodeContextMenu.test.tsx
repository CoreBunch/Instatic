/**
 * layerNodeContextMenu.test.tsx
 *
 * Tests for the LayerNodeContextMenu "Insert module here" submenu:
 * - The submenu trigger is always present.
 * - Hovering it opens a `ContextMenuSubmenu` containing the shared ModulePicker
 *   (search + module/VC list).
 * - Picking a base module routes through useInsertModule with the right-clicked
 *   nodeId as an explicit parent.
 * - Picking a Visual Component routes through insertComponentRef with the
 *   right-clicked nodeId as parent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { LayerNodeContextMenu } from '@site/panels/DomPanel/LayerNodeContextMenu'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import type { VisualComponent } from '@core/visualComponents'
import {
  ConfirmDeleteContext,
  type ConfirmDeleteRequest,
} from '@admin/shared/dialogs/ConfirmDeleteDialog/confirmDeleteHook'
import '@modules/base/index'

afterEach(cleanup)

function makeVC(id: string, name: string): VisualComponent {
  const rootId = `root-${id}`
  return {
    id,
    name,
    tree: {
      rootNodeId: rootId,
      nodes: {
        [rootId]: {
          id: rootId,
          moduleId: 'base.body',
          props: {},
          children: [],
          breakpointOverrides: {},
          classIds: [],
        },
      },
    },
    params: [],
    breakpoints: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
  }
}

function resetStore(vcs: VisualComponent[] = []) {
  localStorage.clear()
  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: {
      'root-home': makeNode({ id: 'root-home', moduleId: 'base.body', children: ['container-node'] }),
      'container-node': makeNode({ id: 'container-node', moduleId: 'base.container' }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [home], files: [], visualComponents: vcs }),
    activePageId: 'page-home',
    selectedNodeId: 'container-node',
    hoveredNodeId: null,
    activeDocument: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const noop = () => {}

function renderMenu(nodeId = 'container-node', vcs: VisualComponent[] = []) {
  resetStore(vcs)
  return render(
    <LayerNodeContextMenu
      x={100}
      y={200}
      nodeId={nodeId}
      onClose={noop}
      onDelete={noop}
      onDuplicate={noop}
      onRename={noop}
      onWrapInContainer={noop}
      onCopy={noop}
      onCut={noop}
      onPaste={noop}
    />,
  )
}

function openInsertSubmenu() {
  // ContextMenuSubmenu opens on mouseEnter — fire that to open the panel.
  const trigger = screen.getByRole('menuitem', { name: /insert module here/i })
  fireEvent.mouseEnter(trigger)
  return trigger
}

beforeEach(() => resetStore())

describe('LayerNodeContextMenu — Insert module here', () => {
  it('renders the "Insert module here" submenu trigger', () => {
    renderMenu()
    expect(screen.getByRole('menuitem', { name: /insert module here/i })).toBeDefined()
  })

  it('opens the module picker submenu on hover', () => {
    renderMenu()
    openInsertSubmenu()

    // ContextMenuSubmenu renders a panel with role="menu" and aria-label
    // matching the trigger label. The picker's search input lives inside.
    expect(screen.getByRole('menu', { name: 'Insert module here' })).toBeDefined()
    expect(screen.getByRole('searchbox', { name: 'Search modules' })).toBeDefined()
  })

  it('inserts a base module into the right-clicked node when picked', () => {
    renderMenu('container-node')
    openInsertSubmenu()

    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const textOption = within(submenu).getAllByRole('menuitem').find(
      (el) => el.getAttribute('data-module-id') === 'base.text',
    )
    expect(textOption).toBeDefined()
    fireEvent.click(textOption!)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    const container = page?.nodes['container-node']
    expect(container?.children.length).toBe(1)

    const insertedId = container?.children[0]
    const inserted = insertedId ? page?.nodes[insertedId] : null
    expect(inserted?.moduleId).toBe('base.text')
  })

  it('inserts a Visual Component into the right-clicked node when picked', () => {
    const vc = makeVC('vc-abc', 'MyCard')
    renderMenu('container-node', [vc])
    openInsertSubmenu()

    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const vcItem = submenu.querySelector('[data-vc-id="vc-abc"]') as HTMLElement
    expect(vcItem).not.toBeNull()
    fireEvent.click(vcItem)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    const container = page?.nodes['container-node']
    expect(container?.children.length).toBe(1)

    const insertedId = container?.children[0]
    const inserted = insertedId ? page?.nodes[insertedId] : null
    expect(inserted?.moduleId).toBe('base.visual-component-ref')
    expect(inserted?.props.componentId).toBe('vc-abc')
  })

  it('falls back to selectedNodeId when nodeId prop is not provided', () => {
    const vc = makeVC('vc-1', 'HeroCard')
    resetStore([vc])

    render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )

    openInsertSubmenu()

    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const vcItem = submenu.querySelector('[data-vc-id="vc-1"]') as HTMLElement
    fireEvent.click(vcItem)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    // selectedNodeId in resetStore is 'container-node' — VC ref should land there.
    const container = page?.nodes['container-node']
    expect(container?.children.length).toBe(1)
  })
})

describe('LayerNodeContextMenu — Componentize', () => {
  it('opens the Properties panel and focuses the component name input', async () => {
    resetStore()
    useEditorStore.setState({
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedSelectorClassIds: ['stale-selector-selection'],
      propertiesPanel: { collapsed: true, x: 0, y: 0, width: 360 },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(
      <>
        <LayerNodeContextMenu
          x={100}
          y={200}
          nodeId="container-node"
          onClose={noop}
          onDelete={noop}
          onDuplicate={noop}
          onRename={noop}
          onWrapInContainer={noop}
          onCopy={noop}
          onCut={noop}
          onPaste={noop}
        />
        <PropertiesPanel variant="docked" />
      </>,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /componentize/i }))

    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(false)
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual([])
    const input = await screen.findByRole('textbox', { name: /component name/i })
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })
  })
})

// ---------------------------------------------------------------------------
// Slot-instance lock-down tests
// ---------------------------------------------------------------------------

/**
 * Builds a page with a VC ref + one slot-instance child, then renders
 * the LayerNodeContextMenu for the slot-instance row.
 *
 *   root (base.body)
 *   └─ vc-ref (base.visual-component-ref)
 *       └─ slot-inst (base.slot-instance, locked)
 */
function resetStoreWithSlotInstance() {
  localStorage.clear()
  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: {
      'root-home': makeNode({ id: 'root-home', moduleId: 'base.body', children: ['vc-ref'] }),
      'vc-ref': makeNode({
        id: 'vc-ref',
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-1' },
        children: ['slot-inst'],
      }),
      'slot-inst': makeNode({
        id: 'slot-inst',
        moduleId: 'base.slot-instance',
        props: { slotName: 'children' },
        children: [],
        locked: true,
      }),
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [home], files: [], visualComponents: [] }),
    activePageId: 'page-home',
    selectedNodeId: 'slot-inst',
    hoveredNodeId: null,
    activeDocument: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('LayerNodeContextMenu — slot-instance lock-down', () => {
  beforeEach(() => resetStoreWithSlotInstance())

  function renderSlotInstanceMenu() {
    return render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId="slot-inst"
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
  }

  it('C1: Delete is NOT present for a slot-instance node', () => {
    renderSlotInstanceMenu()
    const del = screen.queryByRole('menuitem', { name: /delete/i })
    expect(del).toBeNull()
  })

  it('C2: Cut is NOT present for a slot-instance node', () => {
    renderSlotInstanceMenu()
    expect(screen.queryByRole('menuitem', { name: /cut/i })).toBeNull()
  })

  it('C3: Wrap in Container is NOT present for a slot-instance node', () => {
    renderSlotInstanceMenu()
    expect(screen.queryByRole('menuitem', { name: /wrap in container/i })).toBeNull()
  })

  it('C4: Duplicate is NOT present for a slot-instance node', () => {
    renderSlotInstanceMenu()
    expect(screen.queryByRole('menuitem', { name: /duplicate/i })).toBeNull()
  })

  it('C5: Rename is NOT present for a slot-instance node', () => {
    renderSlotInstanceMenu()
    expect(screen.queryByRole('menuitem', { name: /^rename$/i })).toBeNull()
  })

  it('C6: "Insert module here" IS present for a slot-instance node', () => {
    renderSlotInstanceMenu()
    expect(screen.getByRole('menuitem', { name: /insert module here/i })).toBeDefined()
  })

  it('C7: picking a base module from the submenu inserts it INSIDE the slot-instance', () => {
    renderSlotInstanceMenu()
    openInsertSubmenu()

    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const textOption = within(submenu).getAllByRole('menuitem').find(
      (el) => el.getAttribute('data-module-id') === 'base.text',
    )
    expect(textOption).toBeDefined()
    fireEvent.click(textOption!)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    const slotInst = page?.nodes['slot-inst']
    expect(slotInst?.children.length).toBe(1)

    const insertedId = slotInst?.children[0]
    const inserted = insertedId ? page?.nodes[insertedId] : null
    expect(inserted?.moduleId).toBe('base.text')
  })
})

/**
 * The lock-down for `base.slot-instance` rows applies ONLY when the parent is
 * a `base.visual-component-ref`. An orphan slot-instance (e.g. left over from
 * a parallel session before the picker filter was added, or from a migration
 * that put one in the wrong place) must remain a regular node so the user can
 * recover. The lock-down is a structural guard, not a brand on the moduleId.
 */
describe('LayerNodeContextMenu — orphan slot-instance is NOT locked', () => {
  function resetStoreWithOrphanSlotInstance() {
    localStorage.clear()
    const home = makePage({
      id: 'page-home',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root-home',
      nodes: {
        // Orphan slot-instance: parent is base.body, NOT base.visual-component-ref.
        'root-home': makeNode({ id: 'root-home', moduleId: 'base.body', children: ['orphan-slot'] }),
        'orphan-slot': makeNode({
          id: 'orphan-slot',
          moduleId: 'base.slot-instance',
          props: { slotName: 'children' },
          children: [],
        }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [home], files: [], visualComponents: [] }),
      activePageId: 'page-home',
      selectedNodeId: 'orphan-slot',
      hoveredNodeId: null,
      activeDocument: null,
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  beforeEach(() => resetStoreWithOrphanSlotInstance())

  function renderOrphanMenu() {
    return render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId="orphan-slot"
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
  }

  it('Delete IS present for an orphan slot-instance', () => {
    renderOrphanMenu()
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeDefined()
  })

  it('Rename IS present for an orphan slot-instance', () => {
    renderOrphanMenu()
    expect(screen.getByRole('menuitem', { name: /^rename$/i })).toBeDefined()
  })
})

/**
 * "Insert module here" is offered for every single-select target — container
 * AND leaf alike. Right-clicking a leaf (Text, Button, Image, etc.) and
 * inserting must land the new node as the next sibling under the leaf's
 * parent; the shared `resolveInsertLocation` helper handles that fallback
 * uniformly with clipboard paste. Hiding the submenu on leaf targets was the
 * old bug — see the right-click "place doesn't do anything on non-container"
 * report that motivated this gate.
 */
describe('LayerNodeContextMenu — "Insert module here" sibling fallback on leaf targets', () => {
  function setupPageWithMixedNodes() {
    localStorage.clear()
    const home = makePage({
      id: 'page-mixed',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ctr', 'txt', 'btn'] }),
        ctr: makeNode({ id: 'ctr', moduleId: 'base.container' }),
        txt: makeNode({ id: 'txt', moduleId: 'base.text' }),
        btn: makeNode({ id: 'btn', moduleId: 'base.button' }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [home], files: [], visualComponents: [] }),
      activePageId: 'page-mixed',
      selectedNodeId: null,
      selectedNodeIds: [],
      hoveredNodeId: null,
      activeDocument: null,
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  function renderMenuFor(nodeId: string) {
    setupPageWithMixedNodes()
    return render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId={nodeId}
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
  }

  it('"Insert module here" IS shown for a base.container node', () => {
    renderMenuFor('ctr')
    expect(
      screen.getByRole('menuitem', { name: /insert module here/i }),
    ).toBeDefined()
  })

  it('"Insert module here" IS shown for a base.text node (leaf — places as sibling)', () => {
    renderMenuFor('txt')
    expect(
      screen.getByRole('menuitem', { name: /insert module here/i }),
    ).toBeDefined()
  })

  it('"Insert module here" IS shown for a base.button node (leaf — places as sibling)', () => {
    renderMenuFor('btn')
    expect(
      screen.getByRole('menuitem', { name: /insert module here/i }),
    ).toBeDefined()
  })

  it('inserts a module as the NEXT SIBLING when the target is a leaf', () => {
    renderMenuFor('txt')
    const trigger = screen.getByRole('menuitem', { name: /insert module here/i })
    fireEvent.mouseEnter(trigger)

    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const buttonOption = within(submenu).getAllByRole('menuitem').find(
      (el) => el.getAttribute('data-module-id') === 'base.button',
    )
    expect(buttonOption).toBeDefined()
    fireEvent.click(buttonOption!)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-mixed')
    // root.children was [ctr, txt, btn]; right-clicking txt and inserting a
    // base.button should land the new node at index 2 (right after txt),
    // shifting the original btn to index 3.
    const root = page?.nodes['root']
    expect(root?.children.length).toBe(4)
    expect(root?.children[0]).toBe('ctr')
    expect(root?.children[1]).toBe('txt')
    const insertedId = root?.children[2]
    expect(insertedId).toBeDefined()
    expect(page?.nodes[insertedId!]?.moduleId).toBe('base.button')
    expect(root?.children[3]).toBe('btn')
  })

  it('inserts a Visual Component as the NEXT SIBLING when the target is a leaf', () => {
    const vc = makeVC('vc-sibling', 'Hero')
    setupPageWithMixedNodes()
    // Re-set site with the VC available.
    useEditorStore.setState((s) => ({
      ...s,
      site: s.site
        ? { ...s.site, visualComponents: [vc] }
        : s.site,
    }) as Parameters<typeof useEditorStore.setState>[0])

    render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId="btn"
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
    const trigger = screen.getByRole('menuitem', { name: /insert module here/i })
    fireEvent.mouseEnter(trigger)
    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const vcItem = submenu.querySelector('[data-vc-id="vc-sibling"]') as HTMLElement
    expect(vcItem).not.toBeNull()
    fireEvent.click(vcItem)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-mixed')
    const root = page?.nodes['root']
    // Right-clicking btn (last child) → new VC ref lands at the very end.
    expect(root?.children.length).toBe(4)
    expect(root?.children[2]).toBe('btn')
    const insertedId = root?.children[3]
    expect(insertedId).toBeDefined()
    expect(page?.nodes[insertedId!]?.moduleId).toBe('base.visual-component-ref')
    expect(page?.nodes[insertedId!]?.props.componentId).toBe('vc-sibling')
  })

  /**
   * Regression: right-clicking a `base.visual-component-ref` whose referenced
   * Visual Component declares no slot params (and therefore has no
   * `base.slot-instance` children) used to silently no-op because
   * `resolveInsertLocation` returned null when no slot-instance was found.
   * The expected behaviour is to fall through to sibling-after — exactly like
   * a leaf target — so the user's click is never a dead-end.
   */
  it('inserts a module as the NEXT SIBLING when the target is a slotless VC ref', () => {
    localStorage.clear()
    const home = makePage({
      id: 'page-slotless-vc',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['vc-ref'] }),
        'vc-ref': makeNode({
          id: 'vc-ref',
          moduleId: 'base.visual-component-ref',
          props: { componentId: 'slotless-vc', propOverrides: {} },
          // No slot-instance children — the referenced VC has no slot params.
          children: [],
        }),
      },
    })
    useEditorStore.setState({
      site: makeSite({
        pages: [home],
        files: [],
        visualComponents: [makeVC('slotless-vc', 'Slotless')],
      }),
      activePageId: 'page-slotless-vc',
      selectedNodeId: null,
      selectedNodeIds: [],
      hoveredNodeId: null,
      activeDocument: null,
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId="vc-ref"
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
    const trigger = screen.getByRole('menuitem', { name: /insert module here/i })
    fireEvent.mouseEnter(trigger)

    const submenu = screen.getByRole('menu', { name: 'Insert module here' })
    const textOption = within(submenu).getAllByRole('menuitem').find(
      (el) => el.getAttribute('data-module-id') === 'base.text',
    )
    expect(textOption).toBeDefined()
    fireEvent.click(textOption!)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-slotless-vc')
    const root = page?.nodes['root']
    // root.children was [vc-ref]; the new base.text must land as a sibling
    // AFTER vc-ref under root, NOT silently nowhere.
    expect(root?.children.length).toBe(2)
    expect(root?.children[0]).toBe('vc-ref')
    const insertedId = root?.children[1]
    expect(insertedId).toBeDefined()
    expect(page?.nodes[insertedId!]?.moduleId).toBe('base.text')
  })
})

describe('LayerNodeContextMenu — Hide / Unhide', () => {
  function setupHideMenuPage() {
    localStorage.clear()
    const home = makePage({
      id: 'page-hide',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b', 'c'] }),
        a: makeNode({ id: 'a', moduleId: 'base.text' }),
        b: makeNode({ id: 'b', moduleId: 'base.text', hidden: true }),
        c: makeNode({ id: 'c', moduleId: 'base.text', hidden: true }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [home], files: [], visualComponents: [] }),
      activePageId: 'page-hide',
      selectedNodeId: 'a',
      selectedNodeIds: [],
      hoveredNodeId: null,
      activeDocument: null,
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  function renderHideMenu(nodeId: string) {
    return render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId={nodeId}
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
  }

  it('shows Hide for a visible node and marks it hidden when clicked', () => {
    setupHideMenuPage()
    renderHideMenu('a')

    fireEvent.click(screen.getByRole('menuitem', { name: /^hide$/i }))

    expect(useEditorStore.getState().site?.pages[0].nodes.a.hidden).toBe(true)
  })

  it('places Hide first with a divider before the rest of the menu', () => {
    setupHideMenuPage()
    renderHideMenu('a')

    const menu = screen.getByRole('menu', { name: 'Node options' })
    const children = Array.from(menu.children)

    expect(children[0].textContent).toBe('Hide')
    expect(children[1].getAttribute('aria-hidden')).toBe('true')
    expect(children[2].textContent).toBe('Rename')
  })

  it('shows Unhide for a hidden node and marks it visible when clicked', () => {
    setupHideMenuPage()
    renderHideMenu('b')

    fireEvent.click(screen.getByRole('menuitem', { name: /^unhide$/i }))

    expect(useEditorStore.getState().site?.pages[0].nodes.b.hidden).toBe(false)
  })

  it('does not show Hide for the structural root node', () => {
    setupHideMenuPage()
    renderHideMenu('root')

    expect(screen.queryByRole('menuitem', { name: /^hide$/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^unhide$/i })).toBeNull()
  })

  it('hides every selected node when a multi-selection contains a visible node', () => {
    setupHideMenuPage()
    useEditorStore.setState({
      selectedNodeId: 'a',
      selectedNodeIds: ['a', 'b'],
    } as Parameters<typeof useEditorStore.setState>[0])
    renderHideMenu('a')

    fireEvent.click(screen.getByRole('menuitem', { name: /^hide selected$/i }))

    const nodes = useEditorStore.getState().site?.pages[0].nodes
    expect(nodes?.a.hidden).toBe(true)
    expect(nodes?.b.hidden).toBe(true)
  })

  it('unhides every selected node when all selected nodes are hidden', () => {
    setupHideMenuPage()
    useEditorStore.setState({
      selectedNodeId: 'b',
      selectedNodeIds: ['b', 'c'],
    } as Parameters<typeof useEditorStore.setState>[0])
    renderHideMenu('b')

    fireEvent.click(screen.getByRole('menuitem', { name: /^unhide selected$/i }))

    const nodes = useEditorStore.getState().site?.pages[0].nodes
    expect(nodes?.b.hidden).toBe(false)
    expect(nodes?.c.hidden).toBe(false)
  })
})

describe('LayerNodeContextMenu — multi-delete confirmation', () => {
  function setupMultiSelection() {
    localStorage.clear()
    const home = makePage({
      id: 'page-multi',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b', 'c'] }),
        a: makeNode({ id: 'a', moduleId: 'base.text' }),
        b: makeNode({ id: 'b', moduleId: 'base.text' }),
        c: makeNode({ id: 'c', moduleId: 'base.text' }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [home], files: [], visualComponents: [] }),
      activePageId: 'page-multi',
      selectedNodeId: 'b',
      selectedNodeIds: ['a', 'b'],
      hoveredNodeId: null,
      activeDocument: null,
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  it('routes multi-delete through the shared confirm-delete request before mutating', () => {
    setupMultiSelection()
    let pending: ConfirmDeleteRequest | null = null
    let closed = false

    render(
      <ConfirmDeleteContext.Provider
        value={{
          confirmDelete: (request) => {
            pending = request
          },
        }}
      >
        <LayerNodeContextMenu
          x={100}
          y={200}
          nodeId="b"
          onClose={() => { closed = true }}
          onDelete={noop}
          onDuplicate={noop}
          onRename={noop}
          onWrapInContainer={noop}
          onCopy={noop}
          onCut={noop}
          onPaste={noop}
        />
      </ConfirmDeleteContext.Provider>,
    )

    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))
    })

    const pageBeforeConfirm = useEditorStore.getState().site?.pages[0]
    expect(pageBeforeConfirm?.nodes.a).toBeDefined()
    expect(pageBeforeConfirm?.nodes.b).toBeDefined()
    expect(closed).toBe(true)
    expect(pending?.title).toBe('Delete layers?')
    expect(pending?.description).toContain('2 layers')

    act(() => {
      pending?.commit()
    })

    const pageAfterConfirm = useEditorStore.getState().site?.pages[0]
    expect(pageAfterConfirm?.nodes.a).toBeUndefined()
    expect(pageAfterConfirm?.nodes.b).toBeUndefined()
    expect(pageAfterConfirm?.nodes.c).toBeDefined()
  })
})

describe('LayerNodeContextMenu — Add to AI chat', () => {
  function setupAiChatPage() {
    localStorage.clear()
    const home = makePage({
      id: 'page-ai',
      title: 'Home',
      slug: 'index',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a', 'b'] }),
        a: makeNode({ id: 'a', moduleId: 'base.text' }),
        b: makeNode({ id: 'b', moduleId: 'base.button' }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [home], files: [], visualComponents: [] }),
      activePageId: 'page-ai',
      selectedNodeId: 'a',
      selectedNodeIds: ['a'],
      hoveredNodeId: null,
      activeDocument: null,
      isAgentOpen: false,
      agentDraftMentions: [],
      _historyPast: [],
      _historyFuture: [],
      canUndo: false,
      canRedo: false,
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  function renderAiChatMenu(nodeId = 'a') {
    return render(
      <LayerNodeContextMenu
        x={100}
        y={200}
        nodeId={nodeId}
        onClose={noop}
        onDelete={noop}
        onDuplicate={noop}
        onRename={noop}
        onWrapInContainer={noop}
        onCopy={noop}
        onCut={noop}
        onPaste={noop}
      />,
    )
  }

  it('renders the "Add to AI chat" menu item', () => {
    setupAiChatPage()
    renderAiChatMenu()
    expect(screen.getByRole('menuitem', { name: /add to ai chat/i })).toBeDefined()
  })

  it('stages a single node id as the agent draft and opens the panel', () => {
    setupAiChatPage()
    renderAiChatMenu('a')

    fireEvent.click(screen.getByRole('menuitem', { name: /add to ai chat/i }))

    expect(useEditorStore.getState().agentDraftMentions).toEqual([
      { nodeId: 'a', label: '<p>' },
    ])
    expect(useEditorStore.getState().isAgentOpen).toBe(true)
  })

  it('stages multiple selected node ids when right-clicking a multi-selection', () => {
    setupAiChatPage()
    useEditorStore.setState({
      selectedNodeId: 'b',
      selectedNodeIds: ['a', 'b'],
    } as Parameters<typeof useEditorStore.setState>[0])
    renderAiChatMenu('b')

    fireEvent.click(screen.getByRole('menuitem', { name: /add to ai chat/i }))

    expect(useEditorStore.getState().agentDraftMentions).toEqual([
      { nodeId: 'a', label: '<p>' },
      { nodeId: 'b', label: '<button>' },
    ])
    expect(useEditorStore.getState().isAgentOpen).toBe(true)
  })
})
