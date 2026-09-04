/**
 * JsPanel — the God Mode JS column over the page script: lazy creation on
 * the first edit, live-debounced saves through the file slice, page switch
 * with a flushed buffer, and re-sync on external (undo) changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { useEditorStore } from '@site/store/store'
import { findPageScript } from '@core/site-runtime'
import { JsPanel, JS_PANEL_SAVE_DELAY_MS } from '@site/code-dock/js'
import '@modules/base/index'

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, JS_PANEL_SAVE_DELAY_MS + 80))

function state() {
  return useEditorStore.getState()
}

function setup() {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('JS panel')
  const homeId = site.pages[0].id
  const otherId = state().addPage('Other', 'other').id
  state().setActivePage(homeId)
  return { homeId, otherId }
}

async function mountPanel() {
  render(<JsPanel />)
  await waitFor(() => expect(document.querySelector('.cm-editor')).toBeTruthy())
  await nextFrame()
  return editorView()
}

function editorView(): EditorView {
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)
  expect(view).toBeTruthy()
  return view!
}

function typeAtEnd(view: EditorView, insert: string) {
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert } })
  })
}

function pageScript(pageId: string) {
  return findPageScript(state().site!.files, state().siteRuntime, pageId)
}

beforeEach(setup)
afterEach(cleanup)

describe('JsPanel', () => {
  it('creates the page script on the first edit only, then saves live through the file slice', async () => {
    const { homeId } = setup()
    const view = await mountPanel()
    expect(pageScript(homeId)).toBeNull()
    expect(state().site!.files).toHaveLength(0)

    typeAtEnd(view, "console.log('one')")
    expect(state().site!.files).toHaveLength(0)
    await act(afterDebounce)
    const file = pageScript(homeId)!
    expect(file).toMatchObject({ path: 'scripts/pages/index.js', content: "console.log('one')" })
    expect(state().siteRuntime.scripts[file.id].scope).toEqual({ type: 'pages', pageIds: [homeId] })
    expect(screen.getByTestId('js-panel-status').textContent).toContain('scripts/pages/index.js')

    typeAtEnd(view, "\nconsole.log('two')")
    await act(afterDebounce)
    expect(state().site!.files).toHaveLength(1)
    expect(pageScript(homeId)!.content).toBe("console.log('one')\nconsole.log('two')")
    // Own saves keep the buffer mounted.
    expect(editorView()).toBe(view)
  })

  it('does not narrow with element selection', async () => {
    const { homeId } = setup()
    const view = await mountPanel()
    typeAtEnd(view, 'a()')
    await act(afterDebounce)
    const rootId = state().site!.pages[0].rootNodeId
    act(() => {
      state().selectNode(state().insertNode('base.text', {}, rootId))
    })
    await nextFrame()
    expect(editorView()).toBe(view)
    expect(editorView().state.doc.toString()).toBe('a()')
    expect(pageScript(homeId)!.content).toBe('a()')
  })

  it('switches buffers with the page, flushing a pending edit to the previous page script', async () => {
    const { homeId, otherId } = setup()
    const view = await mountPanel()
    typeAtEnd(view, 'home()')
    // Switch before the debounce fires: the pending edit must land on home.
    act(() => {
      state().setActivePage(otherId)
    })
    await waitFor(() => expect(editorView()).not.toBe(view))
    expect(pageScript(homeId)!.content).toBe('home()')
    expect(pageScript(otherId)).toBeNull()
    expect(editorView().state.doc.toString()).toBe('')

    typeAtEnd(editorView(), 'other()')
    await act(afterDebounce)
    expect(pageScript(otherId)!.path).toBe('scripts/pages/other.js')

    act(() => {
      state().setActivePage(homeId)
    })
    await waitFor(() => expect(editorView().state.doc.toString()).toBe('home()'))
  })

  it('re-syncs the buffer when the script changes outside the panel', async () => {
    const { homeId } = setup()
    const view = await mountPanel()
    typeAtEnd(view, 'first()')
    await act(afterDebounce)
    typeAtEnd(view, '\nsecond()')
    await act(afterDebounce)
    expect(pageScript(homeId)!.content).toBe('first()\nsecond()')

    act(() => {
      state().undo()
    })
    expect(pageScript(homeId)!.content).toBe('first()')
    await waitFor(() => expect(editorView().state.doc.toString()).toBe('first()'))
  })
})
