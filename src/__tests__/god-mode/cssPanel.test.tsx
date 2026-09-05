/**
 * CssPanel — the God Mode CSS column end to end: real CodeMirror over the
 * style-rule registry, live debounced apply, undo re-sync, syntax gating,
 * and new-selector creation without auto-assignment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { useEditorStore } from '@site/store/store'
import { CssPanel, CSS_PANEL_APPLY_DELAY_MS } from '@site/code-dock/css'
import '@modules/base/index'

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, CSS_PANEL_APPLY_DELAY_MS + 80))

function state() {
  return useEditorStore.getState()
}

function setup() {
  state().clearSite()
  useEditorStore.setState({
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    activeDocument: null,
    activeClassId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('CSS panel')
  const rootId = site.pages[0].rootNodeId
  const nodeId = state().insertNode('base.text', {}, rootId)
  const card = state().createClass('card', { color: 'red' })
  state().addNodeClass(nodeId, card.id)
  state().selectNode(nodeId)
  return { nodeId, cardId: card.id }
}

async function mountPanel() {
  render(<CssPanel />)
  await waitFor(() => expect(document.querySelector('.cm-editor')).toBeTruthy())
  await nextFrame()
  return editorView()
}

function editorView(): EditorView {
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)
  expect(view).toBeTruthy()
  return view!
}

function replaceInDoc(view: EditorView, search: string, insert: string) {
  const from = view.state.doc.toString().indexOf(search)
  expect(from).toBeGreaterThanOrEqual(0)
  act(() => {
    view.dispatch({ changes: { from, to: from + search.length, insert } })
  })
}

beforeEach(setup)
afterEach(cleanup)

describe('CssPanel', () => {
  it('projects the selection and applies a typed change live, as one undo step the canvas can undo', async () => {
    const { cardId } = setup()
    const view = await mountPanel()
    expect(view.state.doc.toString()).toContain('/* .card · class · used by 1 element */')

    replaceInDoc(view, 'color: red;', 'color: blue;')
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'red' })
    await act(afterDebounce)
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'blue' })
    expect(screen.getByTestId('css-panel-status').getAttribute('data-status')).toBe('idle')
    // Our own apply keeps the editor mounted (no remount, caret survives).
    expect(editorView()).toBe(view)

    act(() => {
      state().undo()
    })
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'red' })
    // An external change (canvas undo) re-syncs the document.
    await waitFor(() => expect(editorView().state.doc.toString()).toContain('color: red;'))
  })

  it('holds applies back while the stylesheet has syntax errors', async () => {
    const { cardId } = setup()
    const view = await mountPanel()

    replaceInDoc(view, 'color: red;\n}', 'color: red;\n')
    await act(afterDebounce)
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'red' })
    expect(screen.getByTestId('css-panel-status').getAttribute('data-status')).toBe('syntax')

    replaceInDoc(view, 'color: red;\n', 'color: green;\n}')
    await act(afterDebounce)
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'green' })
  })

  it('creates a registry rule for a new selector without assigning it to the selection', async () => {
    const { nodeId } = setup()
    const view = await mountPanel()
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n.brand-new {\n  color: hotpink;\n}\n' } })
    })
    await act(afterDebounce)

    const created = Object.values(state().site!.styleRules).find((r) => r.selector === '.brand-new')
    expect(created?.kind).toBe('class')
    expect(created?.styles).toEqual({ color: 'hotpink' })
    expect(state().site!.pages[0].nodes[nodeId].classIds).not.toContain(created!.id)
  })

  it('swaps the document when the selection changes and shows the page sheet with nothing selected', async () => {
    const { nodeId } = setup()
    const view = await mountPanel()
    expect(view.state.doc.toString()).toContain('element {')

    act(() => {
      state().clearSelection()
    })
    await waitFor(() => expect(editorView().state.doc.toString()).not.toContain('element {'))
    expect(editorView().state.doc.toString()).toContain('.card {')

    act(() => {
      state().selectNode(nodeId)
    })
    await waitFor(() => expect(editorView().state.doc.toString()).toContain('element {'))
  })

  it('keeps a buffer that does not parse across a panel remount, and drops the draft once it applies', async () => {
    const { cardId } = setup()
    const view = await mountPanel()
    replaceInDoc(view, 'color: red;', 'color: red; opacity: {')
    await act(afterDebounce)
    expect(screen.getByTestId('css-panel-status').getAttribute('data-status')).toBe('syntax')
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'red' })
    const brokenText = view.state.doc.toString()

    cleanup()
    const again = await mountPanel()
    expect(again.state.doc.toString()).toBe(brokenText)
    expect(screen.getByTestId('css-panel-status').getAttribute('data-status')).toBe('syntax')

    replaceInDoc(again, 'opacity: {', 'opacity: 0.5;')
    await act(afterDebounce)
    expect(state().site!.styleRules[cardId].styles).toEqual({ color: 'red', opacity: '0.5' })
    expect(Object.values(state().codeDockDrafts).some((d) => d.kind === 'css')).toBe(false)
  })
})
