import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModulePickerDropdown } from '@site/toolbar/ModulePickerDropdown'
import { useEditorStore } from '@site/store/store'
import { __resetModuleInserterPreferenceForTests } from '@site/module-picker/useModuleInserterPreference'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  localStorage.clear()
  __resetModuleInserterPreferenceForTests()
  document.body.replaceChildren()
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
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

function loadSite() {
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
    site: makeSite({ pages: [home], files: [], visualComponents: [] }),
    activePageId: 'page-home',
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('ModuleInserterDialog favorites', () => {
  it('renders a favorite toggle for every visible module tile', async () => {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return jsonResponse({ value: JSON.parse(String(init.body)).value })
      return jsonResponse({ value: { favorites: [] } })
    }) as typeof fetch

    loadSite()
    render(<ModulePickerDropdown />)

    fireEvent.click(screen.getByTestId('toolbar-add-module-btn'))
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Add Text to notch favorites' }),
      ).toBeTruthy()
    })

    for (const name of ['Container', 'Loop', 'Text', 'List', 'Content Outlet', 'Image']) {
      const toggle = screen.getByRole('button', {
        name: `Add ${name} to notch favorites`,
      })
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('uses aria-pressed and the label to expose active favorite state', async () => {
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return jsonResponse({ value: JSON.parse(String(init.body)).value })
      }
      return jsonResponse({
        value: { favorites: [{ kind: 'module', id: 'base.text' }] },
      })
    }) as typeof fetch

    loadSite()
    render(<ModulePickerDropdown />)

    fireEvent.click(screen.getByTestId('toolbar-add-module-btn'))
    const activeToggle = await screen.findByRole('button', {
      name: 'Remove Text from notch favorites',
    })
    expect(activeToggle.getAttribute('aria-pressed')).toBe('true')

    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: 'Add Container to notch favorites' })
          .getAttribute('aria-pressed'),
      ).toBe('false')
    })
  })

  it('toggles a module favorite without inserting or closing the dialog', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      if (init?.method === 'PUT') return jsonResponse({ value: JSON.parse(String(init.body)).value })
      return jsonResponse({ value: { favorites: [] } })
    }) as typeof fetch

    loadSite()
    render(<ModulePickerDropdown />)

    fireEvent.click(screen.getByTestId('toolbar-add-module-btn'))
    const toggle = await screen.findByRole('button', {
      name: 'Add Text to notch favorites',
    })
    fireEvent.click(toggle)

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PUT')).toBe(true))
    expect(screen.getByRole('dialog', { name: 'Add to canvas' })).toBeTruthy()

    const page = useEditorStore.getState().site?.pages.find((item) => item.id === 'page-home')
    const textNodes = page
      ? Object.values(page.nodes).filter((node) => node.moduleId === 'base.text')
      : []
    expect(textNodes).toHaveLength(0)

    const save = calls.find((call) => call.init?.method === 'PUT')
    expect(JSON.parse(String(save?.init?.body))).toEqual({
      value: { favorites: [{ kind: 'module', id: 'base.text' }] },
    })
  })
})
