/**
 * HtmlPanel as an inspector (reverse selection sync): the cursor's element
 * hover-highlights its node in the store, uid-less content highlights
 * nothing, tag clicks select the node and re-scope, and leaving the panel
 * drops its highlight.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { useEditorStore } from '@site/store/store'
import { HtmlPanel } from '@site/code-dock/html'
import '@modules/base/index'

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

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
    hoveredNodeId: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('Inspector')
  const rootId = site.pages[0].rootNodeId
  const container = state().insertNode('base.container', {}, rootId)
  const text = state().insertNode('base.text', { text: 'Hello there' }, container)
  return { rootId, container, text }
}

async function mountPanel(): Promise<EditorView> {
  render(<HtmlPanel />)
  await waitFor(() => expect(document.querySelector('.cm-editor')).toBeTruthy())
  await nextFrame()
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
  expect(view).toBeTruthy()
  return view
}

function moveCursorTo(view: EditorView, search: string, offset = 1) {
  const index = view.state.doc.toString().indexOf(search)
  expect(index).toBeGreaterThanOrEqual(0)
  act(() => {
    view.focus()
    view.dispatch({ selection: { anchor: index + offset } })
  })
}

beforeEach(setup)
afterEach(cleanup)

describe('HtmlPanel inspector', () => {
  it('hovers the node whose markup the cursor is in, and nothing for uid-less content', async () => {
    const { container, text } = setup()
    const view = await mountPanel()
    moveCursorTo(view, 'Hello there')
    expect(state().hoveredNodeId).toBe(text)
    moveCursorTo(view, `uid="${container}"`, 3)
    expect(state().hoveredNodeId).toBe(container)

    // A tag typed but not applied has no uid: no highlight, no error.
    const end = view.state.doc.toString().lastIndexOf('</')
    act(() => {
      view.dispatch({ changes: { from: end, insert: '<span>new</span>' }, selection: { anchor: end + 7 } })
    })
    expect(state().hoveredNodeId).toBeNull()
    // A uid the tree does not know is not a node either.
    act(() => {
      view.dispatch({
        changes: { from: end, to: end + '<span>new</span>'.length, insert: '<span uid="ghost">new</span>' },
        selection: { anchor: end + 19 },
      })
    })
    expect(state().hoveredNodeId).toBeNull()
  })

  it('selects the node whose tag name is clicked and re-scopes the panel to it', async () => {
    const { container, text } = setup()
    const view = await mountPanel()
    expect(view.state.doc.toString()).toContain(`uid="${container}"`)
    // The click path resolves the tag under the pointer; drive its handler
    // through the same prop the editor calls.
    const { uidOfTagNameAt } = await import('@site/code-editor/uidInspector')
    const pos = view.state.doc.toString().indexOf(`<p uid="${text}"`) + 1
    const uid = uidOfTagNameAt(view.state, pos)
    expect(uid).toBe(text)
    act(() => {
      state().selectNode(uid!)
    })
    await waitFor(() => {
      const next = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
      expect(next.state.doc.toString().startsWith(`<p uid="${text}"`)).toBe(true)
    })
    expect(state().selectedNodeId).toBe(text)
  })

  it('shows the cursor element ancestry as breadcrumbs and selects an ancestor on click', async () => {
    const { rootId, container, text } = setup()
    state().selectNode(text)
    const view = await mountPanel()
    const crumbs = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="html-panel-crumb"]'))
    expect(crumbs().map((c) => c.dataset.nodeId)).toEqual([rootId, container, text])
    expect(crumbs()[2].getAttribute('aria-pressed')).toBe('true')
    moveCursorTo(view, 'Hello there')
    expect(crumbs().map((c) => c.dataset.nodeId)).toEqual([rootId, container, text])
    act(() => {
      crumbs()[1].click()
    })
    expect(state().selectedNodeId).toBe(container)
    await waitFor(() => expect(crumbs().map((c) => c.dataset.nodeId)).toEqual([rootId, container]))
  })

  it('is inert in the read-only view of Component-instance internals', async () => {
    const { container } = setup()
    const vcId = state().createVisualComponent('Card')
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const vcRootId = state().site!.visualComponents.find((v) => v.id === vcId)!.tree.rootNodeId
    const internalId = state().insertNode('base.text', { text: 'Inside', tag: 'p' }, vcRootId)
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    state().insertComponentRef(container, vcId)
    state().selectNode(internalId)
    const view = await mountPanel()
    expect(view.state.doc.toString()).toContain(`uid="${internalId}"`)
    moveCursorTo(view, 'Inside')
    expect(state().hoveredNodeId).toBeNull()
    const { uidOfTagNameAt } = await import('@site/code-editor/uidInspector')
    expect(uidOfTagNameAt(view.state, 1)).toBe(internalId)
    // The panel's click handler refuses in the read-only view; selection stays.
    expect(state().selectedNodeId).toBe(internalId)
  })

  it('drops its own hover highlight on unmount, but never a hover it does not own', async () => {
    const { text, container } = setup()
    const view = await mountPanel()
    moveCursorTo(view, 'Hello there')
    expect(state().hoveredNodeId).toBe(text)
    cleanup()
    expect(state().hoveredNodeId).toBeNull()

    const again = await mountPanel()
    moveCursorTo(again, 'Hello there')
    act(() => {
      state().hoverNode(container)
    })
    cleanup()
    expect(state().hoveredNodeId).toBe(container)
  })
})
