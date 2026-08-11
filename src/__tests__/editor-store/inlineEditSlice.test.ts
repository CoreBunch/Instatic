/**
 * Inline text edit slice tests — session lifecycle, live-commit coalescing
 * (one undo entry per burst), Escape-cancel via single undo, and start
 * guards (non-editable modules, link-with-children, non-string props).
 * Spec: docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
 */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { useEditorStore } from '@site/store/store'
// Side-effect imports: register the modules under test into the global registry.
import '@modules/base/text'
import '@modules/base/button'
import '@modules/base/link'
import '@modules/base/container'

function setupSiteWithTextNode(text = 'Hello'): { nodeId: string; rootId: string; pageId: string } {
  const store = useEditorStore.getState()
  const site = store.createSite('Inline Edit Test Site')
  const pageId = site.pages[0].id
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', { text }, rootId)
  return { nodeId, rootId, pageId }
}

function nodeText(nodeId: string): unknown {
  const site = useEditorStore.getState().site!
  for (const page of site.pages) {
    if (page.nodes[nodeId]) return page.nodes[nodeId].props.text
  }
  return undefined
}

beforeEach(() => {
  // clearSite also resets the collab binding's docs + undo history.
  useEditorStore.getState().clearSite()
  useEditorStore.setState({
    activePageId: null,
    activeDocument: null,
    activeInlineEdit: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
  })
})

describe('startInlineEdit', () => {
  it('opens a multiline session for base.text on the text prop', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toEqual({
      nodeId,
      prop: 'text',
      breakpointId: 'bp-desktop',
      multiline: true,
      initialValue: 'Hello',
      committed: false,
    })
  })

  it('opens a single-line session for base.button on the label prop', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const buttonId = useEditorStore.getState().insertNode('base.button', { label: 'Go' }, rootId)
    useEditorStore.getState().startInlineEdit(buttonId, 'bp-mobile')
    const session = useEditorStore.getState().activeInlineEdit
    expect(session?.prop).toBe('label')
    expect(session?.multiline).toBe(false)
    expect(session?.initialValue).toBe('Go')
  })

  it('opens a session for a childless base.link on the text prop', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const linkId = useEditorStore.getState().insertNode('base.link', {}, rootId)
    useEditorStore.getState().startInlineEdit(linkId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit?.prop).toBe('text')
  })

  it('no-ops for modules without inlineTextEdit', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().startInlineEdit(containerId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('no-ops for base.link with children (text renders only childless)', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const linkId = useEditorStore.getState().insertNode('base.link', {}, rootId)
    useEditorStore.getState().insertNode('base.text', {}, linkId)
    useEditorStore.getState().startInlineEdit(linkId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('no-ops with a [canvas] warning when the stored prop is not a string', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().updateNodeProps(nodeId, { text: 42 })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toStartWith('[canvas]')
    warn.mockRestore()
  })

  it('no-ops for unknown node ids', () => {
    setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit('does-not-exist', 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})

describe('applyInlineEditValue — live commit, one undo entry per burst', () => {
  it('commits every keystroke live and coalesces the burst into ONE undo step', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('HelloW')
    useEditorStore.getState().applyInlineEditValue('HelloWo')
    useEditorStore.getState().applyInlineEditValue('HelloWorld')
    expect(nodeText(nodeId)).toBe('HelloWorld')
    expect(useEditorStore.getState().activeInlineEdit?.committed).toBe(true)
    // ONE undo reverts the whole burst — not one keystroke.
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBe('Hello')
  })

  it('a single undo() reverts the whole burst to the initial value', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('A')
    useEditorStore.getState().applyInlineEditValue('AB')
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBe('Hello')
  })

  it('does not flip committed when the applied value equals the stored value', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('Hello')
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit?.committed).toBe(false)
    // No history entry was pushed: undo reverts the node INSERT, not a
    // (nonexistent) equal-value edit.
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBeUndefined()
  })

  it('isolates the session burst from a prior Properties-panel burst on the same prop', () => {
    const { nodeId } = setupSiteWithTextNode()
    // Simulate panel typing: same coalesce key the inline session will use.
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'PanelTyped' })
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('PanelTypedX')
    // Escape reverts ONLY the inline burst, not the panel typing.
    useEditorStore.getState().cancelInlineEdit()
    expect(nodeText(nodeId)).toBe('PanelTyped')
  })

  it('no-ops without an active session', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().applyInlineEditValue('ignored')
    expect(nodeText(nodeId)).toBe('Hello')
  })
})

describe('endInlineEdit', () => {
  it('closes the session and ends the burst so later edits undo separately', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('HelloA')
    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(nodeText(nodeId)).toBe('HelloA')
    // A later edit of the SAME prop starts a fresh undo entry: the first
    // undo reverts only it, back to the session's committed value.
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'HelloB' })
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBe('HelloA')
  })
})

describe('cancelInlineEdit', () => {
  it('reverts a committed session with exactly one undo', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('Mangled')
    useEditorStore.getState().cancelInlineEdit()
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit).toBeNull()
    expect(nodeText(nodeId)).toBe('Hello')
    // The cancel consumed the burst's undo step: the next undo reverts the
    // node insert itself.
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBeUndefined()
  })

  it('does NOT undo for an uncommitted session', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().cancelInlineEdit()
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit).toBeNull()
    expect(nodeText(nodeId)).toBe('Hello')
    // History untouched: the next undo reverts the node insert.
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBeUndefined()
  })
})

describe('force-close', () => {
  it('clears the session when the edited node is deleted', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().deleteNode(nodeId)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session when the edited node is swept with a deleted ancestor', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const textId = useEditorStore.getState().insertNode('base.text', { text: 'Hi' }, containerId)
    useEditorStore.getState().startInlineEdit(textId, 'bp')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    useEditorStore.getState().deleteNode(containerId)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session on page switch', () => {
    const { nodeId, pageId } = setupSiteWithTextNode()
    // addPage activates the new page — hop back before starting the session.
    const pageB = useEditorStore.getState().addPage('Second', 'second')
    useEditorStore.getState().openPageInCanvas(pageId)
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    useEditorStore.getState().openPageInCanvas(pageB.id)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session on active-document switch', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId: 'vc-x' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})
