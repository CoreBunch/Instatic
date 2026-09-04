/**
 * HtmlPanel — the God Mode HTML column end to end: projection of the
 * selection, live apply gated on syntax, one undo step per flush, per-scope
 * held drafts, read-only Component internals with jump-to-definition, and a
 * token / instatic-* round trip — plus the apply guardrails, which hold an
 * edit for the explicit Apply: the destructive-diff confirm and the
 * stale-draft banner.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { useEditorStore } from '@site/store/store'
import { HtmlPanel, HTML_PANEL_APPLY_DELAY_MS } from '@site/code-dock/html'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'
import '@modules/base/index'

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
/** Let the live-apply debounce flush. */
const afterDebounce = () => act(() => new Promise((resolve) => setTimeout(resolve, HTML_PANEL_APPLY_DELAY_MS + 80)))

function state() {
  return useEditorStore.getState()
}

function setup() {
  state().clearSite()
  useEditorStore.setState({ activePageId: null, activeDocument: null, selectedNodeId: null, selectedNodeIds: [] } as Parameters<typeof useEditorStore.setState>[0])
  const site = state().createSite('HTML panel')
  const page = site.pages[0]
  const containerId = state().insertNode('base.container', {}, page.rootNodeId)
  const textId = state().insertNode('base.text', { text: 'Hello {page.title}', tag: 'p' }, containerId)
  const siblingId = state().insertNode('base.text', { text: 'Bye', tag: 'p' }, containerId)
  state().renameNode(siblingId, 'Farewell')
  return { pageId: page.id, rootId: page.rootNodeId, containerId, textId, siblingId }
}

async function mountPanel() {
  render(<HtmlPanel />)
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

const status = () => screen.getByTestId('html-panel-status').getAttribute('data-status')
const applyButton = () => screen.getByTestId('html-panel-apply') as HTMLButtonElement
// With a tooltip the Button primitive expresses disabled via aria-disabled.
const applyDisabled = () => applyButton().disabled || applyButton().getAttribute('aria-disabled') === 'true'
const confirmDialog = () => screen.queryByTestId('html-panel-confirm-dialog')
const docText = () => editorView().state.doc.toString()

function removeElement(view: EditorView, uid: string) {
  const text = view.state.doc.toString()
  const parsed = new DOMParser().parseFromString(`<body>${text}</body>`, 'text/html')
  const target = parsed.body.querySelector(`[uid="${uid}"]`)
  expect(target).toBeTruthy()
  const outer = target!.outerHTML
  const from = text.indexOf(outer)
  expect(from).toBeGreaterThanOrEqual(0)
  act(() => {
    view.dispatch({ changes: { from, to: from + outer.length, insert: '' } })
  })
}

async function clickApply() {
  await act(async () => {
    fireEvent.click(applyButton())
  })
}

beforeEach(setup)
afterEach(cleanup)

describe('HtmlPanel', () => {
  it('advertises the registered apply shortcut', () => {
    expect(getKeybindingForCommand('godMode.applyHtml')?.shortcut.win).toBe('Ctrl+Enter')
  })

  it('projects the selection reflowed, applies live as one undo step, and keeps untouched identity', async () => {
    const { containerId, textId, siblingId } = setup()
    state().selectNode(containerId)
    const view = await mountPanel()
    expect(view.state.doc.toString()).toContain(`\n  <p uid="${textId}">Hello {page.title}</p>\n`)
    expect(applyDisabled()).toBe(true)
    expect(screen.getByTestId('html-panel-format')).toBeTruthy()

    replaceInDoc(view, 'Hello {page.title}', 'Hi {page.title}')
    // Nothing touched the tree before the debounce.
    expect(state().site!.pages[0].nodes[textId].props.text).toBe('Hello {page.title}')
    await afterDebounce()
    expect(confirmDialog()).toBeNull()
    const page = state().site!.pages[0]
    expect(page.nodes[textId].props.text).toBe('Hi {page.title}')
    expect(page.nodes[siblingId].label).toBe('Farewell')
    expect(status()).toBe('clean')
    expect(screen.getByTestId('html-panel-status').textContent).toContain('Applied')
    // The live apply keeps the buffer mounted (caret survives).
    expect(editorView()).toBe(view)

    act(() => {
      state().undo()
    })
    expect(state().site!.pages[0].nodes[textId].props.text).toBe('Hello {page.title}')
    await waitFor(() => expect(editorView().state.doc.toString()).toContain('Hello {page.title}'))
  })

  it('holds a document that does not parse, with visible diagnostics, until it parses again', async () => {
    const { containerId, textId } = setup()
    state().selectNode(containerId)
    const view = await mountPanel()
    replaceInDoc(view, 'Hello {page.title}</p>', 'Hi {page.title}</p')
    await afterDebounce()
    expect(status()).toBe('syntax')
    expect(applyDisabled()).toBe(true)
    expect(state().site!.pages[0].nodes[textId].props.text).toBe('Hello {page.title}')
    const brokenAt = view.state.doc.toString().indexOf('</p')
    act(() => {
      view.dispatch({ changes: { from: brokenAt + 3, insert: '>' } })
    })
    await afterDebounce()
    expect(status()).toBe('clean')
    expect(state().site!.pages[0].nodes[textId].props.text).toBe('Hi {page.title}')
  })

  it('shows the whole page when nothing is selected and keeps a held draft across selection changes', async () => {
    const { containerId, textId } = setup()
    state().selectNode(textId)
    const view = await mountPanel()
    replaceInDoc(view, 'Hello', 'Draft</b')
    await afterDebounce()
    expect(status()).toBe('syntax')

    act(() => {
      state().clearSelection()
    })
    await waitFor(() => expect(editorView().state.doc.toString()).toContain(`uid="${containerId}"`))
    expect(status()).toBe('clean')

    act(() => {
      state().selectNode(textId)
    })
    await waitFor(() => expect(editorView().state.doc.toString()).toContain('Draft</b'))
    expect(status()).toBe('syntax')
  })

  it('keeps a held draft in the store across a panel remount (expanding into the dialog)', async () => {
    const { containerId, textId } = setup()
    state().toggleNodeLocked(textId)
    state().selectNode(containerId)
    const view = await mountPanel()
    removeElement(view, textId)
    await afterDebounce()
    expect(status()).toBe('held')
    const heldText = docText()
    expect(Object.values(state().codeDockDrafts).some((d) => d.kind === 'html' && d.held?.kind === 'destructive')).toBe(true)

    cleanup()
    expect(document.querySelector('.cm-editor')).toBeNull()
    await mountPanel()
    expect(status()).toBe('held')
    expect(docText()).toBe(heldText)
    expect(state().site!.pages[0].nodes[textId]).toBeTruthy()
  })

  it("renders Component-instance internals read-only with a working jump to the definition", async () => {
    const { containerId } = setup()
    const vcId = state().createVisualComponent('Card')
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const vcRootId = state().site!.visualComponents.find((v) => v.id === vcId)!.tree.rootNodeId
    const internalId = state().insertNode('base.text', { text: 'Inside', tag: 'p' }, vcRootId)
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    const refId = state().insertComponentRef(containerId, vcId)!
    state().selectNode(internalId)

    const view = await mountPanel()
    expect(status()).toBe('read-only')
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
    expect(screen.queryByTestId('html-panel-apply')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('html-panel-open-definition'))
    })
    expect(state().activeDocument).toEqual({ kind: 'visualComponent', vcId })
    await waitFor(() => expect(status()).toBe('clean'))
    expect(editorView().contentDOM.getAttribute('contenteditable')).toBe('true')

    // Consumer side, the instance itself projects as an opaque marker that survives an edit-and-apply.
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    act(() => {
      state().selectNode(containerId)
    })
    await waitFor(() => expect(editorView().state.doc.toString()).toContain('<instatic-component'))
    replaceInDoc(editorView(), 'Hello {page.title}', 'Hey {page.title}')
    await afterDebounce()
    const page = state().site!.pages[0]
    expect(page.nodes[refId]).toMatchObject({ moduleId: 'base.visual-component-ref', parentId: containerId })
    expect(Object.values(page.nodes).some((n) => n.props.text === 'Hey {page.title}')).toBe(true)
  })

  it('round-trips a slot instance and its user content through an edit-and-apply', async () => {
    const { containerId } = setup()
    const vcId = state().createVisualComponent('Card')
    useEditorStore.setState({ activeDocument: { kind: 'visualComponent', vcId } } as Parameters<typeof useEditorStore.setState>[0])
    const vcRootId = state().site!.visualComponents.find((v) => v.id === vcId)!.tree.rootNodeId
    state().insertNode('base.slot-outlet', { slotName: 'body' }, vcRootId)
    useEditorStore.setState({ activeDocument: null } as Parameters<typeof useEditorStore.setState>[0])
    const refId = state().insertComponentRef(containerId, vcId)!
    const slotId = state().site!.pages[0].nodes[refId].children[0]
    expect(state().site!.pages[0].nodes[slotId].moduleId).toBe('base.slot-instance')
    const fillId = state().insertNode('base.text', { text: 'Filled', tag: 'p' }, slotId)
    state().selectNode(containerId)

    const view = await mountPanel()
    expect(view.state.doc.toString()).toContain('<instatic-slot')
    expect(view.state.doc.toString()).toContain(`<p uid="${fillId}">Filled</p>`)
    replaceInDoc(view, 'Filled', 'Filled twice')
    await afterDebounce()
    const page = state().site!.pages[0]
    expect(page.nodes[slotId]).toMatchObject({ moduleId: 'base.slot-instance', parentId: refId })
    expect(page.nodes[fillId]).toMatchObject({ parentId: slotId, props: { text: 'Filled twice' } })
  })

  describe('apply guardrails', () => {
    it('confirms before deleting a locked node, listing it; cancel leaves the tree untouched', async () => {
      const { containerId, textId } = setup()
      state().renameNode(textId, 'Legal text')
      state().toggleNodeLocked(textId)
      state().selectNode(containerId)
      const view = await mountPanel()
      removeElement(view, textId)
      await afterDebounce()
      expect(status()).toBe('held')
      expect(screen.getByTestId('html-panel-status').textContent).toContain('Legal text')
      expect(applyDisabled()).toBe(false)
      expect(state().site!.pages[0].nodes[textId]).toBeTruthy()

      await clickApply()
      const dialog = confirmDialog()
      expect(dialog).toBeTruthy()
      expect(dialog!.textContent).toContain('Legal text')
      expect(dialog!.textContent).toContain('locked')
      expect(state().site!.pages[0].nodes[textId]).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-confirm-cancel'))
      })
      expect(confirmDialog()).toBeNull()
      expect(state().site!.pages[0].nodes[textId]).toBeTruthy()
      expect(status()).toBe('held')
      expect(docText()).not.toContain(`uid="${textId}"`)

      await clickApply()
      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-confirm'))
      })
      expect(confirmDialog()).toBeNull()
      expect(state().site!.pages[0].nodes[textId]).toBeUndefined()
      expect(status()).toBe('clean')
    })

    it('confirms before removing a Component instance, naming the component', async () => {
      const { containerId } = setup()
      const vcId = state().createVisualComponent('Card')
      const refId = state().insertComponentRef(containerId, vcId)!
      state().selectNode(containerId)
      const view = await mountPanel()
      removeElement(view, refId)
      await afterDebounce()
      expect(status()).toBe('held')
      expect(state().site!.pages[0].nodes[refId]).toBeTruthy()
      await clickApply()
      const dialog = confirmDialog()
      expect(dialog).toBeTruthy()
      expect(dialog!.textContent).toContain('Card')
      expect(dialog!.textContent).toContain('component')
      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-confirm'))
      })
      expect(state().site!.pages[0].nodes[refId]).toBeUndefined()
    })

    it('keeps a held draft verbatim and shows the banner when the subtree changes remotely', async () => {
      const { containerId, textId, siblingId } = setup()
      state().toggleNodeLocked(textId)
      state().selectNode(containerId)
      const view = await mountPanel()
      removeElement(view, textId)
      await afterDebounce()
      expect(status()).toBe('held')
      const draftText = docText()
      expect(screen.queryByTestId('html-panel-stale')).toBeNull()

      act(() => {
        state().updateNodeProps(siblingId, { text: 'Remote' })
      })
      await waitFor(() => expect(status()).toBe('stale'))
      expect(screen.getByTestId('html-panel-stale')).toBeTruthy()
      expect(docText()).toBe(draftText)

      // Apply now needs the explicit overwrite confirmation, then wins.
      await clickApply()
      const dialog = confirmDialog()
      expect(dialog).toBeTruthy()
      expect(dialog!.textContent).toMatch(/changed/i)
      expect(state().site!.pages[0].nodes[siblingId].props.text).toBe('Remote')
      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-confirm'))
      })
      const page = state().site!.pages[0]
      expect(page.nodes[textId]).toBeUndefined()
      expect(page.nodes[siblingId].props.text).toBe('Bye')
      expect(status()).toBe('clean')
      expect(screen.queryByTestId('html-panel-stale')).toBeNull()
    })

    it('takes the stale path when a tree change is undone under a held draft', async () => {
      const { containerId, siblingId } = setup()
      state().toggleNodeLocked(siblingId)
      state().selectNode(containerId)
      const view = await mountPanel()
      replaceInDoc(view, 'Hello {page.title}', 'First {page.title}')
      await afterDebounce()
      expect(status()).toBe('clean')
      expect(state().site!.pages[0].nodes[containerId].children).toContain(siblingId)

      removeElement(editorView(), siblingId)
      await afterDebounce()
      expect(status()).toBe('held')
      act(() => {
        state().undo()
      })
      await waitFor(() => expect(status()).toBe('stale'))
      expect(docText()).not.toContain(`uid="${siblingId}"`)
      expect(state().site!.pages[0].nodes[siblingId]).toBeTruthy()
    })

    it('discarding a stale draft shows the remote projection', async () => {
      const { containerId, textId, siblingId } = setup()
      state().toggleNodeLocked(textId)
      state().selectNode(containerId)
      const view = await mountPanel()
      removeElement(view, textId)
      await afterDebounce()
      act(() => {
        state().updateNodeProps(siblingId, { text: 'Remote' })
      })
      await waitFor(() => expect(status()).toBe('stale'))
      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-discard'))
      })
      await waitFor(() => expect(docText()).toContain('Remote'))
      expect(docText()).toContain(`uid="${textId}"`)
      expect(status()).toBe('clean')
      expect(state().site!.pages[0].nodes[textId]).toBeTruthy()
      expect(state().site!.pages[0].nodes[siblingId].props.text).toBe('Remote')
    })

    it('refreshes a clean panel on a remote change with no banner', async () => {
      const { containerId, siblingId } = setup()
      state().selectNode(containerId)
      await mountPanel()
      act(() => {
        state().updateNodeProps(siblingId, { text: 'Remote' })
      })
      await waitFor(() => expect(docText()).toContain('Remote'))
      expect(status()).toBe('clean')
      expect(screen.queryByTestId('html-panel-stale')).toBeNull()
    })

    it('re-validates the confirm when the tree changes while the dialog is open', async () => {
      const { containerId, textId, siblingId } = setup()
      state().toggleNodeLocked(textId)
      state().selectNode(containerId)
      const view = await mountPanel()
      removeElement(view, textId)
      await afterDebounce()
      await clickApply()
      expect(confirmDialog()!.textContent).not.toMatch(/changed/i)

      act(() => {
        state().updateNodeProps(siblingId, { text: 'Remote' })
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-confirm'))
      })
      // The summary no longer matched: the dialog re-opened with the stale notice instead of committing.
      expect(confirmDialog()).toBeTruthy()
      expect(confirmDialog()!.textContent).toMatch(/changed/i)
      expect(state().site!.pages[0].nodes[textId]).toBeTruthy()

      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-confirm'))
      })
      expect(confirmDialog()).toBeNull()
      expect(state().site!.pages[0].nodes[textId]).toBeUndefined()
      expect(state().site!.pages[0].nodes[siblingId].props.text).toBe('Bye')
    })

    it('surfaces a draft whose element was removed remotely instead of dropping it', async () => {
      const { textId } = setup()
      state().renameNode(textId, 'Intro')
      state().selectNode(textId)
      const view = await mountPanel()
      replaceInDoc(view, 'Hello', 'Orphan</b')
      await afterDebounce()
      expect(status()).toBe('syntax')

      act(() => {
        state().deleteNode(textId)
      })
      await waitFor(() => expect(screen.queryByTestId('html-panel-orphaned')).toBeTruthy())
      expect(screen.getByTestId('html-panel-orphaned').textContent).toContain('Intro')
      // The panel moved on to the page scope; the draft is not applied anywhere.
      expect(status()).toBe('clean')
      expect(Object.values(state().site!.pages[0].nodes).some((n) => n.props.text === 'Orphan')).toBe(false)

      await act(async () => {
        fireEvent.click(screen.getByTestId('html-panel-orphan-dismiss'))
      })
      expect(screen.queryByTestId('html-panel-orphaned')).toBeNull()
    })
  })
})
