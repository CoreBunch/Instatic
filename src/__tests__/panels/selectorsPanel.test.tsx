import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SelectorsPanel } from '@site/panels/SelectorsPanel'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import {
  buildClassTokenUsageMap,
  buildSelectorUsageMap,
  formatSelectorUsage,
  getReusableClasses,
  getSelectorStyleSummary,
  resolveSelectorUsage,
} from '@site/panels/selectorUsage'
import { selectRightSidebarExpanded, useEditorStore } from '@site/store/store'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const SRC_ROOT = join(import.meta.dir, '../../')

afterEach(cleanup)

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    selectedSelectorClassId: null,
    selectedSelectorClassIds: [],
    selectorsPanelOpen: false,
    dependenciesPanelOpen: false,
    propertiesPanel: { collapsed: true, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

function makeClass(
  id: string,
  name: string,
  styles: Record<string, unknown> = {},
  overrides: Partial<StyleRule> = {},
): StyleRule {
  return {
    id,
    name,
    kind: 'class',
    selector: classKindSelector(name),
    order: 0,
    styles,
    contextStyles: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function loadSiteWithSelectors() {
  const rootNode = makeNode({ id: 'root-1', moduleId: 'base.body', children: ['text-1', 'button-1'] })
  const textNode = makeNode({ id: 'text-1', moduleId: 'base.text', classIds: ['hero-title'], props: { text: 'Hero', tag: 'h1' } })
  const buttonNode = makeNode({ id: 'button-1', moduleId: 'base.button', classIds: ['hero-title', 'cta-button'], props: { label: 'Buy' } })
  const page = makePage({
    id: 'page-1',
    rootNodeId: 'root-1',
    nodes: {
      'root-1': rootNode,
      'text-1': textNode,
      'button-1': buttonNode,
    },
  })

  useEditorStore.setState({
    site: makeSite({
      pages: [page],
      styleRules: {
        'hero-title': makeClass('hero-title', 'hero-title', { fontSize: '48px', color: '#111' }, {
          contextStyles: { mobile: { fontSize: '32px' } },
        }),
        'cta-button': makeClass('cta-button', 'cta-button', { padding: '12px' }),
        'unused-card': makeClass('unused-card', 'unused-card'),
        'text-m': makeClass('text-m', 'text-m', { fontSize: '16px' }, {
          generated: {
            origin: 'framework',
            family: 'typography',
            sourceId: 'group-1',
            generatorId: 'gen-1',
            tokenName: 'text',
            step: 'm',
            locked: true,
          },
        }),
        'internal-style': makeClass('internal-style', 'Text instance text-1', { color: '#333' }, {
          scope: { type: 'node', nodeId: 'text-1', role: 'module-style' },
          tags: ['module-instance'],
        }),
      },
    }),
    activePageId: 'page-1',
    selectorsPanelOpen: true,
  } as Parameters<typeof useEditorStore.setState>[0])

  return { textNodeId: 'text-1', buttonNodeId: 'button-1' }
}

describe('selectorUsage helpers', () => {
  it('formats reusable selector usage and style summaries', () => {
    loadSiteWithSelectors()
    const state = useEditorStore.getState()

    expect(getReusableClasses(state.site!.styleRules).map((cls) => cls.id)).toEqual([
      'hero-title',
      'cta-button',
      'unused-card',
      'text-m',
    ])
    const usage = buildSelectorUsageMap(state.site)
    expect(usage.get('hero-title') ?? 0).toBe(2)
    expect(usage.get('unused-card') ?? 0).toBe(0)
    expect(formatSelectorUsage(0)).toBe('Unused')
    expect(formatSelectorUsage(1)).toBe('Used 1 time')
    expect(formatSelectorUsage(2)).toBe('Used 2 times')
    expect(getSelectorStyleSummary(state.site!.styleRules['hero-title'])).toBe('2 props · 1 context')
    expect(getSelectorStyleSummary(state.site!.styleRules['unused-card'])).toBe('No styles')
  })

  it('reports ambient selector usage only when provably dead', () => {
    loadSiteWithSelectors()
    const site = useEditorStore.getState().site
    const usageById = buildSelectorUsageMap(site)
    const tokenUsage = buildClassTokenUsageMap(site!.styleRules, usageById)

    // Rollup keys by the escaped `.name` selector and excludes ambient rules.
    expect(tokenUsage.get('.hero-title')).toBe(2)
    expect(tokenUsage.get('.unused-card')).toBe(0)

    const ambient = (selector: string): StyleRule => ({
      id: `amb-${selector}`,
      name: selector,
      kind: 'ambient',
      selector,
      order: 0,
      styles: {},
      contextStyles: {},
      createdAt: 1,
      updatedAt: 1,
    })
    const usage = (selector: string) =>
      resolveSelectorUsage(ambient(selector), usageById, tokenUsage)

    // Anchored on a still-used class → can't prove dead → no badge.
    expect(usage('.hero-title span')).toEqual({ label: null, unused: false })
    // Anchored on a class nothing uses → provably dead. Pseudo doesn't matter.
    expect(usage('.unused-card::before')).toEqual({ label: 'Unused', unused: true })
    // Descendant needs both; one dead anchor means it can never match.
    expect(usage('.hero-title .unused-card')).toEqual({ label: 'Unused', unused: true })
    // Tag-only / universal: unassessable, never falsely claimed unused.
    expect(usage('body')).toEqual({ label: null, unused: false })
    expect(usage('*')).toEqual({ label: null, unused: false })
    // Selector list matches if ANY group can → one live group keeps it alive.
    expect(usage('.unused-card, .hero-title')).toEqual({ label: null, unused: false })
    // …every group dead → provably unused.
    expect(usage('.unused-card, .text-m')).toEqual({ label: 'Unused', unused: true })

    // Class rules keep exact reference counts.
    expect(resolveSelectorUsage(site!.styleRules['hero-title'], usageById, tokenUsage)).toEqual({
      label: 'Used 2 times',
      unused: false,
    })
  })
})

describe('SelectorsPanel', () => {
  it('lists only reusable user classes with usage and style metadata', () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    expect(within(panel).getByRole('button', { name: /edit selector \.hero-title/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.cta-button/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.unused-card/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()
    expect(within(panel).getByText('.hero-title')).toBeDefined()
    expect(within(panel).getByText('.cta-button')).toBeDefined()
    expect(within(panel).getByText('.unused-card')).toBeDefined()
    expect(within(panel).queryByText('Text instance text-1')).toBeNull()
    expect(within(panel).getByText('Used 2 times')).toBeDefined()
    expect(within(panel).getByText('2 props · 1 context')).toBeDefined()
  })

  it('filters selectors by All / User / Utility', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    const filterGroup = within(panel).getByRole('group', { name: /selector type/i })
    const allButton = within(filterGroup).getByRole('button', { name: /^all$/i })
    const userButton = within(filterGroup).getByRole('button', { name: /^user$/i })
    const utilityButton = within(filterGroup).getByRole('button', { name: /^utility$/i })

    expect(allButton.getAttribute('aria-pressed')).toBe('true')
    expect(within(panel).getByRole('button', { name: /edit selector \.hero-title/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()

    fireEvent.click(userButton)
    expect(within(panel).getByRole('button', { name: /edit selector \.hero-title/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.cta-button/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.unused-card/i })).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /edit selector \.text-m/i })).toBeNull()

    fireEvent.click(utilityButton)
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /edit selector \.hero-title/i })).toBeNull()
    expect(within(panel).queryByRole('button', { name: /edit selector \.cta-button/i })).toBeNull()
    expect(within(panel).queryByRole('button', { name: /edit selector \.unused-card/i })).toBeNull()

    fireEvent.click(allButton)
    expect(within(panel).getByRole('button', { name: /edit selector \.hero-title/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()
  })

  it('combines the User filter with the search query', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(panel).getByRole('button', { name: /^user$/i }))
    fireEvent.change(within(panel).getByRole('searchbox', { name: /search selectors/i }), {
      target: { value: 'cta' },
    })

    expect(within(panel).getByRole('button', { name: /edit selector \.cta-button/i })).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /edit selector \.hero-title/i })).toBeNull()
    expect(within(panel).queryByRole('button', { name: /edit selector \.text-m/i })).toBeNull()
  })

  it('filters to only unused selectors', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(panel).getByRole('button', { name: /^unused$/i }))

    // unused-card (no nodes) and text-m (no nodes) are unused; hero-title and
    // cta-button are referenced by page nodes.
    expect(within(panel).getByRole('button', { name: /edit selector \.unused-card/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /edit selector \.hero-title/i })).toBeNull()
    expect(within(panel).queryByRole('button', { name: /edit selector \.cta-button/i })).toBeNull()
  })

  it('searches selector property names and values, not just names', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    const search = within(panel).getByRole('searchbox', { name: /search selectors/i })

    // Property name match: both hero-title (48px) and text-m (16px) set font-size.
    fireEvent.change(search, { target: { value: 'font-size' } })
    expect(within(panel).getByRole('button', { name: /edit selector \.hero-title/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /edit selector \.cta-button/i })).toBeNull()

    // Property name + value match narrows to the one rule with that declaration.
    fireEvent.change(search, { target: { value: 'font-size: 16px' } })
    expect(within(panel).getByRole('button', { name: /edit selector \.text-m/i })).toBeDefined()
    expect(within(panel).queryByRole('button', { name: /edit selector \.hero-title/i })).toBeNull()
  })

  it('multi-selects selectors via row checkboxes and shows the bulk inspector', () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.hero-title/i }))
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual(['hero-title'])
    expect(screen.getByText(/1 selector selected/i)).toBeDefined()

    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.cta-button/i }))
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual(['hero-title', 'cta-button'])
    expect(screen.getByText(/2 selectors selected/i)).toBeDefined()

    const propertiesPanel = screen.getByTestId('properties-panel')
    expect(within(propertiesPanel).getByRole('button', { name: /duplicate/i })).toBeDefined()
    expect(within(propertiesPanel).getByRole('button', { name: /delete/i })).toBeDefined()

    // The docked right sidebar must expand (take layout width) for a selector
    // multi-selection, even with no node / single selector active — otherwise
    // the bulk options would render at zero width.
    expect(selectRightSidebarExpanded(useEditorStore.getState())).toBe(true)
  })

  it('bulk-applies selected selectors to the selected element', () => {
    const { textNodeId } = loadSiteWithSelectors()
    useEditorStore.setState({ selectedNodeId: textNodeId } as Parameters<typeof useEditorStore.setState>[0])
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.cta-button/i }))

    const propertiesPanel = screen.getByTestId('properties-panel')
    fireEvent.click(within(propertiesPanel).getByRole('button', { name: /^apply$/i }))

    expect(useEditorStore.getState().site!.pages[0].nodes[textNodeId].classIds ?? []).toContain('cta-button')
  })

  it('keeps bulk apply enabled for locked utility selectors', () => {
    const { textNodeId } = loadSiteWithSelectors()
    useEditorStore.setState({ selectedNodeId: textNodeId } as Parameters<typeof useEditorStore.setState>[0])
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    // text-m is a locked generated utility — "locked" must not block applying it
    // to an element (applying utilities is their whole purpose).
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.text-m/i }))

    const propertiesPanel = screen.getByTestId('properties-panel')
    const apply = within(propertiesPanel).getByRole('button', { name: /^apply$/i }) as HTMLButtonElement
    expect(apply.disabled).toBe(false)

    fireEvent.click(apply)
    expect(useEditorStore.getState().site!.pages[0].nodes[textNodeId].classIds ?? []).toContain('text-m')
  })

  it('shows a sticky selection toolbar with select-all and deselect-all', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    // No toolbar until a selection exists.
    expect(within(panel).queryByRole('group', { name: /selection actions/i })).toBeNull()

    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.hero-title/i }))
    const toolbar = within(panel).getByRole('group', { name: /selection actions/i })
    expect(within(toolbar).getByText(/1 selected/i)).toBeDefined()

    // Select all → every reusable selector in the current (unfiltered) view.
    fireEvent.click(within(toolbar).getByRole('button', { name: /^select all$/i }))
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual([
      'hero-title',
      'cta-button',
      'unused-card',
      'text-m',
    ])

    // Deselect all → clears the set and hides the toolbar.
    fireEvent.click(within(toolbar).getByRole('button', { name: /^deselect all$/i }))
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual([])
    expect(within(panel).queryByRole('group', { name: /selection actions/i })).toBeNull()
  })

  it('select-all respects the active filter', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(panel).getByRole('button', { name: /^user$/i }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.hero-title/i }))
    fireEvent.click(within(panel).getByRole('button', { name: /^select all$/i }))

    // text-m (utility) is filtered out, so it is not selected.
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual([
      'hero-title',
      'cta-button',
      'unused-card',
    ])
  })

  it('bulk-applies as a single undo step', () => {
    const { textNodeId } = loadSiteWithSelectors()
    useEditorStore.setState({ selectedNodeId: textNodeId } as Parameters<typeof useEditorStore.setState>[0])
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    // text-1 starts with [hero-title]; apply two more in one batch.
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.cta-button/i }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.text-m/i }))

    const propertiesPanel = screen.getByTestId('properties-panel')
    fireEvent.click(within(propertiesPanel).getByRole('button', { name: /^apply$/i }))

    const afterApply = useEditorStore.getState().site!.pages[0].nodes[textNodeId].classIds ?? []
    expect(afterApply).toEqual(['hero-title', 'cta-button', 'text-m'])

    // A single undo reverts the entire batch, not one class at a time.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[textNodeId].classIds ?? []).toEqual(['hero-title'])
  })

  it('disables bulk delete and duplicate for locked utility selectors', () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    // text-m is a locked generated utility — neither delete nor duplicate applies.
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.text-m/i }))

    const propertiesPanel = screen.getByTestId('properties-panel')
    // These buttons carry a tooltip, so the Button primitive uses aria-disabled
    // (keeps the explanatory tooltip reachable) rather than the native attribute.
    const deleteBtn = () => within(propertiesPanel).getByRole('button', { name: /^delete$/i })
    const duplicateBtn = () => within(propertiesPanel).getByRole('button', { name: /^duplicate$/i })
    expect(deleteBtn().getAttribute('aria-disabled')).toBe('true')
    expect(duplicateBtn().getAttribute('aria-disabled')).toBe('true')

    // Add a normal user class → both re-enable (they act on the editable subset).
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.cta-button/i }))
    expect(deleteBtn().getAttribute('aria-disabled')).toBeNull()
    expect(duplicateBtn().getAttribute('aria-disabled')).toBeNull()

    // Deleting only removes the editable one; the locked utility survives.
    fireEvent.click(deleteBtn())
    const rules = useEditorStore.getState().site!.styleRules
    expect(rules['cta-button']).toBeUndefined()
    expect(rules['text-m']).toBeDefined()
  })

  it('bulk-deletes selected selectors', () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const panel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.unused-card/i }))
    fireEvent.click(within(panel).getByRole('checkbox', { name: /select selector \.cta-button/i }))

    const propertiesPanel = screen.getByTestId('properties-panel')
    // No ConfirmDeleteProvider in this render → confirmDelete commits immediately.
    fireEvent.click(within(propertiesPanel).getByRole('button', { name: /^delete$/i }))

    const rules = useEditorStore.getState().site!.styleRules
    expect(rules['unused-card']).toBeUndefined()
    expect(rules['cta-button']).toBeUndefined()
    expect(rules['hero-title']).toBeDefined()
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual([])
  })

  it('shows an empty utility message when no utility classes exist', () => {
    loadSiteWithSelectors()
    const { 'text-m': _utility, ...rest } = useEditorStore.getState().site!.styleRules
    void _utility
    useEditorStore.setState({
      site: makeSite({ pages: useEditorStore.getState().site!.pages, styleRules: rest }),
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<SelectorsPanel variant="docked" />)
    fireEvent.click(screen.getByRole('button', { name: /^utility$/i }))
    expect(screen.getByText(/no utility selectors yet/i)).toBeDefined()
  })

  it('shows empty and search-empty states', () => {
    loadSiteWithSelectors()
    useEditorStore.setState({
      site: makeSite({ pages: useEditorStore.getState().site!.pages, styleRules: {} }),
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<SelectorsPanel variant="docked" />)
    expect(screen.getByText(/no reusable selectors yet/i)).toBeDefined()

    cleanup()
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)
    fireEvent.change(screen.getByRole('searchbox', { name: /search selectors/i }), {
      target: { value: 'missing' },
    })
    expect(screen.getByText(/no selectors match/i)).toBeDefined()
  })

  it('filters selector rows by search text', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    fireEvent.change(screen.getByRole('searchbox', { name: /search selectors/i }), {
      target: { value: 'cta' },
    })

    expect(screen.queryByRole('button', { name: /edit selector \.hero-title/i })).toBeNull()
    expect(screen.getByRole('button', { name: /edit selector \.cta-button/i })).toBeDefined()
  })

  it('places the single create action beside search instead of in the panel header', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    const panel = screen.getByTestId('selectors-panel')
    const header = within(panel).getByRole('toolbar', { name: 'Selectors panel header' })
    const search = within(panel).getByRole('searchbox', { name: /search selectors/i })
    const searchRow = search.closest('div')?.parentElement

    expect(within(header).queryByRole('button', { name: /create selector/i })).toBeNull()
    expect(within(panel).queryByRole('button', { name: /create ambient selector/i })).toBeNull()
    expect(searchRow).not.toBeNull()
    expect(within(searchRow as HTMLElement).getByRole('button', { name: 'Create selector' })).toBeDefined()
  })

  it('creates a reusable selector from the search-row create action and opens it for editing', async () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: /create selector/i }))
    expect(screen.queryByRole('button', { name: /^class$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /full selector/i })).toBeNull()
    const selectorInput = screen.getByRole('textbox', { name: /^selector$/i })
    expect(selectorInput.getAttribute('placeholder')).toContain('.hero .title')
    fireEvent.change(selectorInput, {
      target: { value: '.feature-card' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    const created = Object.values(useEditorStore.getState().site!.styleRules).find(
      (cls) => cls.name === 'feature-card',
    )
    expect(created).toBeDefined()
    expect(useEditorStore.getState().activeClassId).toBe(created!.id)
    await waitFor(() => expect(screen.getByTestId('properties-panel')).toBeDefined())
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(false)
    const propertiesPanel = screen.getByTestId('properties-panel')
    expect(within(propertiesPanel).getByRole('heading', { name: '.feature-card' })).toBeDefined()
    expect(within(propertiesPanel).getByRole('button', { name: /rename selector \.feature-card/i })).toBeDefined()
    expect(within(propertiesPanel).queryByRole('region', { name: /selector feature-card/i })).toBeNull()
  })

  it('creates an ambient selector from the same create dialog', async () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create selector' }))
    fireEvent.change(screen.getByRole('textbox', { name: /^selector$/i }), {
      target: { value: '.feature-card:hover' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    const created = Object.values(useEditorStore.getState().site!.styleRules).find(
      (cls) => cls.kind === 'ambient' && cls.selector === '.feature-card:hover',
    )
    expect(created).toBeDefined()
    expect(useEditorStore.getState().activeClassId).toBe(created!.id)
    await waitFor(() => expect(screen.getByTestId('properties-panel')).toBeDefined())
    expect(within(screen.getByTestId('properties-panel')).getByRole('heading', { name: '.feature-card:hover' })).toBeDefined()
  })

  it('selecting a row opens the global class editor in the right properties panel', async () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const selectorsPanel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(selectorsPanel).getByRole('button', { name: /edit selector \.hero-title/i }))

    expect(within(selectorsPanel).queryByRole('searchbox', { name: /search class style properties to add/i })).toBeNull()
    await waitFor(() => expect(screen.getByTestId('properties-panel')).toBeDefined())
    const propertiesPanel = screen.getByTestId('properties-panel')
    expect(within(propertiesPanel).getByRole('heading', { name: '.hero-title' })).toBeDefined()
    expect(within(propertiesPanel).queryByRole('region', { name: /selector hero-title/i })).toBeNull()
    expect(within(propertiesPanel).getByRole('searchbox', { name: /search class style properties to add/i })).toBeDefined()
    expect(screen.queryByRole('textbox', { name: /add or create a css class/i })).toBeNull()
    expect(useEditorStore.getState().activeClassId).toBe('hero-title')
    expect(useEditorStore.getState().propertiesPanel.collapsed).toBe(false)

    fireEvent.click(within(propertiesPanel).getByRole('button', { name: /rename selector \.hero-title/i }))
    const classNameInput = within(propertiesPanel).getByRole('textbox', { name: /class name/i })
    expect((classNameInput as HTMLInputElement).value).toBe('.hero-title')
    fireEvent.change(classNameInput, { target: { value: '.feature-heading' } })
    fireEvent.blur(classNameInput)

    await waitFor(() => {
      expect(useEditorStore.getState().site!.styleRules['hero-title'].name).toBe('feature-heading')
    })
    expect(within(propertiesPanel).getByRole('heading', { name: '.feature-heading' })).toBeDefined()
  })

  it('opens an ambient selector editor without adding an extra class dot', async () => {
    loadSiteWithSelectors()
    const ambient = useEditorStore.getState().createAmbientRule({ selector: '.auth-back:hover' })
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    const selectorsPanel = screen.getByTestId('selectors-panel')
    fireEvent.click(within(selectorsPanel).getByRole('button', { name: /edit selector \.auth-back:hover/i }))

    await waitFor(() => expect(screen.getByTestId('properties-panel')).toBeDefined())
    const propertiesPanel = screen.getByTestId('properties-panel')
    expect(useEditorStore.getState().activeClassId).toBe(ambient.id)
    expect(within(propertiesPanel).getByRole('heading', { name: '.auth-back:hover' })).toBeDefined()
    expect(within(propertiesPanel).queryByRole('heading', { name: '..auth-back:hover' })).toBeNull()
  })

  it('edit from the selector context menu opens the right properties panel editor', async () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.cta-button/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^edit$/i }))

    await waitFor(() => expect(screen.getByTestId('properties-panel')).toBeDefined())
    const propertiesPanel = screen.getByTestId('properties-panel')
    expect(within(propertiesPanel).getByRole('heading', { name: '.cta-button' })).toBeDefined()
    expect(useEditorStore.getState().activeClassId).toBe('cta-button')
  })

  it('opens selector context menu from pointer and keyboard', () => {
    loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )
    const row = screen.getByRole('button', { name: /edit selector \.hero-title/i })

    fireEvent.contextMenu(row, { clientX: 20, clientY: 30 })
    expect(screen.getByRole('menu', { name: /selector actions/i })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeDefined()

    fireEvent.click(document.body)
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    expect(screen.getByRole('menu', { name: /selector actions/i })).toBeDefined()
  })

  it('duplicates a selector from the context menu without copying assignments', async () => {
    const { buttonNodeId } = loadSiteWithSelectors()
    render(
      <>
        <SelectorsPanel variant="docked" />
        <PropertiesPanel variant="docked" />
      </>,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.cta-button/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /duplicate/i }))

    const classes = useEditorStore.getState().site!.styleRules
    const copy = Object.values(classes).find((cls) => cls.name === 'cta-button-copy')
    expect(copy).toBeDefined()
    expect(copy!.styles).toEqual({ padding: '12px' })
    expect(useEditorStore.getState().site!.pages[0].nodes[buttonNodeId].classIds).toEqual(['hero-title', 'cta-button'])
    await waitFor(() => expect(screen.getByTestId('properties-panel')).toBeDefined())
    expect(within(screen.getByTestId('properties-panel')).getByRole('heading', { name: '.cta-button-copy' })).toBeDefined()
  })

  it('applies and removes a selector from the selected element via context menu', () => {
    const { textNodeId } = loadSiteWithSelectors()
    useEditorStore.setState({ selectedNodeId: textNodeId } as Parameters<typeof useEditorStore.setState>[0])
    render(<SelectorsPanel variant="docked" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.cta-button/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /apply to selected element/i }))
    expect(useEditorStore.getState().site!.pages[0].nodes[textNodeId].classIds ?? []).toContain('cta-button')

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.cta-button/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /remove from selected element/i }))
    expect(useEditorStore.getState().site!.pages[0].nodes[textNodeId].classIds ?? []).not.toContain('cta-button')
  })

  it('renames and deletes selectors with confirmation', () => {
    loadSiteWithSelectors()
    render(<SelectorsPanel variant="docked" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.unused-card/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))
    const dialogClassNameInput = screen.getByRole('textbox', { name: /class name/i })
    expect((dialogClassNameInput as HTMLInputElement).value).toBe('.unused-card')
    fireEvent.change(dialogClassNameInput, {
      target: { value: '.renamed-card' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(useEditorStore.getState().site!.styleRules['unused-card'].name).toBe('renamed-card')

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.renamed-card/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))
    // Destructive confirmations use role=alertdialog (Dialog primitive,
    // tone="danger"). alertdialog is the correct ARIA role for prompts
    // that interrupt the user with a destructive choice.
    const deleteDialog = screen.getByRole('alertdialog', { name: /delete selector/i })
    expect(deleteDialog.textContent).toContain('Delete .renamed-card?')
    expect(deleteDialog.textContent).not.toContain('renamed-card (')
    expect(within(deleteDialog).getByText(/this selector is unused/i)).toBeDefined()
    fireEvent.click(within(deleteDialog).getByRole('button', { name: /delete selector/i }))
    expect(useEditorStore.getState().site!.styleRules['unused-card']).toBeUndefined()
  })

  it('copies the user-facing selector from the context menu', async () => {
    loadSiteWithSelectors()
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text
        },
      },
    })

    try {
      render(<SelectorsPanel variant="docked" />)
      fireEvent.contextMenu(screen.getByRole('button', { name: /edit selector \.hero-title/i }))
      fireEvent.click(screen.getByRole('menuitem', { name: /copy selector/i }))
      await Promise.resolve()
      expect(copied).toBe('.hero-title')
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
    }
  })
})

describe('SelectorsPanel architecture', () => {
  it('wires selectors into the panel rail and left sidebar', () => {
    const railSource = readFileSync(join(SRC_ROOT, 'admin/pages/site/sidebars/PanelRail/PanelRail.tsx'), 'utf-8')
    const sidebarSource = readFileSync(join(SRC_ROOT, 'admin/pages/site/sidebars/LeftSidebar/LeftSidebar.tsx'), 'utf-8')

    expect(railSource).toContain("id: 'selectors'")
    expect(sidebarSource).toContain('SelectorsPanel')
  })

  it('new selectors panel files avoid inline styles Tailwind and important flags', () => {
    const files = [
      'admin/pages/site/panels/SelectorsPanel/SelectorsPanel.tsx',
      'admin/pages/site/panels/SelectorsPanel/SelectorsPanel.module.css',
    ]

    for (const file of files) {
      const source = readFileSync(join(SRC_ROOT, file), 'utf-8')
      expect(source).not.toContain('style={')
      expect(source).not.toContain('className="')
      expect(source).not.toContain('!important')
    }
  })
})
