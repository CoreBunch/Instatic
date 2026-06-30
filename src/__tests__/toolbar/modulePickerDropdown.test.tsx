/**
 * modulePickerDropdown.test.tsx
 *
 * Tests for the site-VC integration in ModulePickerDropdown:
 * - VCs appear in the Components section with name + param count
 * - Search filter matches VC names
 * - Clicking a VC tile calls insertComponentRef
 * - base.slot-outlet visibility gated by VC edit mode
 * - base.visual-component-ref never shown
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ModulePickerDropdown } from '@site/toolbar/ModulePickerDropdown'
import { useEditorStore } from '@site/store/store'
import { __resetModuleInserterPreferenceForTests } from '@site/module-picker/useModuleInserterPreference'
import { makeNode, makePage, makeSite } from '../fixtures'
import type { VisualComponent } from '@core/visualComponents'
import '@modules/base/index'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

function resetStore() {
  localStorage.clear()
  __resetModuleInserterPreferenceForTests()
  globalThis.fetch = mock(async () => jsonResponse({ value: null })) as typeof fetch
  useEditorStore.setState({
    site: null,
    activePageId: null,
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

function makeVC(id: string, name: string, paramCount = 0): VisualComponent {
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
    params: Array.from({ length: paramCount }, (_, i) => ({
      id: `param-${i}`,
      name: `param${i}`,
      type: 'string' as const,
      defaultValue: '',
      required: false,
    })),
    breakpoints: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
  }
}

function loadSite(
  vcs: VisualComponent[] = [],
  activeDocument: { kind: 'visualComponent'; vcId: string } | null = null,
) {
  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: {
      'root-home': makeNode({ id: 'root-home', moduleId: 'base.body' }),
    },
  })

  useEditorStore.setState({
    site: makeSite({ pages: [home], files: [], visualComponents: vcs }),
    activePageId: 'page-home',
    activeDocument,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

function openInserter(): HTMLElement {
  fireEvent.click(screen.getByTestId('toolbar-add-module-btn'))
  return screen.getByRole('dialog', { name: 'Add to canvas' })
}

function clickSection(name: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}\\b`) }))
}

describe('ModulePickerDropdown — Visual Components', () => {
  it('exposes stable names for inserter category buttons when labels are visually hidden', () => {
    loadSite()
    render(<ModulePickerDropdown />)

    const dialog = openInserter()
    const categories = within(dialog).getByRole('navigation', { name: 'Module categories' })
    for (const name of ['Modules', 'Layouts', 'Components', 'Recent']) {
      const button = within(categories).getByRole('button', {
        name: new RegExp(`^${name}\\b`),
      })
      expect(button.getAttribute('aria-label')).toBe(name)
    }
  })

  it('lists site VCs as items inside the Components section', () => {
    loadSite([
      makeVC('vc-1', 'HeroCard', 3),
      makeVC('vc-2', 'PricingTable', 1),
    ])
    render(<ModulePickerDropdown />)

    const dialog = openInserter()
    clickSection('Components')

    expect(within(dialog).getAllByText('HeroCard').length).toBeGreaterThan(0)
    expect(within(dialog).getAllByText('PricingTable').length).toBeGreaterThan(0)
  })

  it('renders data-vc-id attribute on VC items', () => {
    loadSite([makeVC('vc-abc', 'MyComponent', 0)])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()
    clickSection('Components')

    const vcItem = dialog.querySelector('[data-vc-id="vc-abc"]')
    expect(vcItem?.getAttribute('data-vc-id')).toBe('vc-abc')
  })

  it('filters VCs by search query', () => {
    loadSite([
      makeVC('vc-1', 'HeroCard', 2),
      makeVC('vc-2', 'PricingTable', 1),
    ])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()
    clickSection('Components')

    const searchBox = screen.getByRole('searchbox', { name: 'Search modules' })
    fireEvent.change(searchBox, { target: { value: 'hero' } })

    expect(within(dialog).getAllByText('HeroCard').length).toBeGreaterThan(0)
    expect(within(dialog).queryByText('PricingTable')).toBeNull()
  })

  it('calls insertComponentRef with correct parent when a VC item is clicked', () => {
    loadSite([makeVC('vc-1', 'HeroCard', 0)])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()
    clickSection('Components')

    // Use the data-vc-id to find and click the VC item
    const vcItem = dialog.querySelector('[data-vc-id="vc-1"]') as HTMLElement
    expect(vcItem).not.toBeNull()
    fireEvent.click(vcItem)

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    const nodes = page?.nodes
    const refs = nodes
      ? Object.values(nodes).filter((n) => n.moduleId === 'base.visual-component-ref')
      : []
    expect(refs.length).toBe(1)
    expect(refs[0]?.props.componentId).toBe('vc-1')
  })

  it('closes the inserter after clicking a VC item', () => {
    loadSite([makeVC('vc-1', 'HeroCard', 0)])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()
    clickSection('Components')

    const vcItem = dialog.querySelector('[data-vc-id="vc-1"]') as HTMLElement
    fireEvent.click(vcItem)

    expect(screen.queryByRole('dialog', { name: 'Add to canvas' })).toBeNull()
  })

  it('closes the inserter after clicking a module item', () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    const textItem = dialog.querySelector('[data-module-id="base.text"]') as HTMLElement
    expect(textItem).not.toBeNull()
    fireEvent.click(textItem)

    expect(screen.queryByRole('dialog', { name: 'Add to canvas' })).toBeNull()

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    const textNodes = page
      ? Object.values(page.nodes).filter((node) => node.moduleId === 'base.text')
      : []
    expect(textNodes.length).toBe(1)
  })

  it('does not expose unfinished community catalog affordances', () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    expect(screen.queryByRole('button', { name: /^Community\b/ })).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'Search modules' }).getAttribute('placeholder'))
      .toBe('Search every module, layout & component...')
    expect(within(dialog).queryByText('Plugin catalog unavailable')).toBeNull()
    expect(within(dialog).queryByText(/Community modules/i)).toBeNull()
  })

  it('drops into the breakpoint frame under the pointer and activates that frame', () => {
    loadSite([])
    useEditorStore.getState().setActiveBreakpoint('desktop')
    render(<ModulePickerDropdown />)
    const dialog = openInserter()
    installCanvasViewport('desktop', { left: 0, top: 0, width: 200, height: 300 })
    installCanvasViewport('mobile', { left: 240, top: 0, width: 120, height: 300 })

    const textItem = dialog.querySelector('[data-module-id="base.text"]') as HTMLElement
    expect(textItem).not.toBeNull()

    fireEvent.pointerDown(textItem, { button: 0, clientX: 20, clientY: 20 })
    fireEvent.pointerMove(window, { clientX: 260, clientY: 100 })
    fireEvent.pointerUp(window, { clientX: 260, clientY: 100 })

    expect(screen.queryByRole('dialog', { name: 'Add to canvas' })).toBeNull()
    expect(useEditorStore.getState().activeBreakpointId).toBe('mobile')

    const state = useEditorStore.getState()
    const page = state.site?.pages.find((p) => p.id === 'page-home')
    const textNodes = page
      ? Object.values(page.nodes).filter((node) => node.moduleId === 'base.text')
      : []
    expect(textNodes.length).toBe(1)
  })

  it('does not let idle hover replace the selected item', async () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    const loopItem = dialog.querySelector('[data-module-id="base.loop"]') as HTMLElement
    const textItem = dialog.querySelector('[data-module-id="base.text"]') as HTMLElement
    fireEvent.focus(loopItem)
    await waitFor(() => expect(loopItem?.getAttribute('data-selected')).toBe('true'))

    fireEvent.mouseEnter(textItem)

    expect(loopItem?.getAttribute('data-selected')).toBe('true')
    expect(textItem?.getAttribute('data-selected')).toBeNull()
  })

  it('does preview the item under actual pointer movement', async () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    const loopItem = dialog.querySelector('[data-module-id="base.loop"]') as HTMLElement
    const textItem = dialog.querySelector('[data-module-id="base.text"]') as HTMLElement
    fireEvent.focus(loopItem)
    await waitFor(() => expect(loopItem?.getAttribute('data-selected')).toBe('true'))

    fireEvent.pointerMove(textItem, { clientX: 120, clientY: 120 })

    expect(textItem?.getAttribute('data-selected')).toBe('true')
    expect(loopItem?.getAttribute('data-selected')).toBeNull()
  })

  it('hides base.visual-component-ref from the picker in page mode', () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    // base.visual-component-ref should not appear as a module item
    const vcRefItem = within(dialog).queryAllByRole('button').find(
      (el) => el.getAttribute('data-module-id') === 'base.visual-component-ref',
    )
    expect(vcRefItem).toBeUndefined()
  })

  it('hides base.slot-outlet in page mode (name: Slot)', () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    // base.slot-outlet (display name: "Slot") should not appear in page mode
    const slotItem = within(dialog).queryAllByRole('button').find(
      (el) => el.getAttribute('data-module-id') === 'base.slot-outlet',
    )
    expect(slotItem).toBeUndefined()
  })

  it('shows base.slot-outlet in VC edit mode', () => {
    const vc = makeVC('vc-1', 'HeroCard', 0)
    loadSite([vc], { kind: 'visualComponent', vcId: vc.id })
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    // base.slot-outlet (display name: "Slot") should be visible in VC mode
    const slotItem = within(dialog).queryAllByRole('button').find(
      (el) => el.getAttribute('data-module-id') === 'base.slot-outlet',
    )
    expect(slotItem).toBeDefined()
  })

  it('hides base.slot-instance in page mode (auto-materialized only)', () => {
    loadSite([])
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    // base.slot-instance is materialized as a VC ref child by syncSlotInstances —
    // it must NEVER appear as a user-insertable option in the picker. Otherwise
    // the picker shows two "Slot" entries (one for slot-outlet, one for
    // slot-instance) and orphan slot-instance nodes leak into the tree.
    const slotInstanceItem = within(dialog).queryAllByRole('button').find(
      (el) => el.getAttribute('data-module-id') === 'base.slot-instance',
    )
    expect(slotInstanceItem).toBeUndefined()
  })

  it('hides base.slot-instance in VC edit mode (auto-materialized only)', () => {
    const vc = makeVC('vc-1', 'HeroCard', 0)
    loadSite([vc], { kind: 'visualComponent', vcId: vc.id })
    render(<ModulePickerDropdown />)
    const dialog = openInserter()

    // Same rule as page mode — slot-instance is structural-only, never picker-visible.
    const slotInstanceItem = within(dialog).queryAllByRole('button').find(
      (el) => el.getAttribute('data-module-id') === 'base.slot-instance',
    )
    expect(slotInstanceItem).toBeUndefined()
  })
})

function installCanvasViewport(
  breakpointId: string,
  rect: { left: number; top: number; width: number; height: number },
) {
  const viewport = document.createElement('div')
  viewport.dataset.breakpointId = breakpointId
  Object.defineProperty(viewport, 'offsetWidth', {
    configurable: true,
    value: rect.width,
  })
  viewport.getBoundingClientRect = () => ({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  })
  document.body.append(viewport)
}
