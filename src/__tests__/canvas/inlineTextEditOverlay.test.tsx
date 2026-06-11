/**
 * InlineTextEditOverlay component tests — per-frame render gating, field
 * variant (textarea vs input), live commit through the store, and the
 * Enter / Shift+Enter / Escape / blur / unmount end-of-session semantics.
 *
 * iframeElement is null in these tests: positioning + typography mirroring
 * need a live iframe (covered by the manual smoke test); the session
 * semantics under test are iframe-independent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { InlineTextEditOverlay } from '@site/canvas/InlineTextEditOverlay'
import '@modules/base/text'
import '@modules/base/button'

const FIELD_SELECTOR = '[data-testid="canvas-inline-edit-field"]'

function seedSession(multiline = true): { nodeId: string } {
  const store = useEditorStore.getState()
  const site = store.createSite('Overlay Test Site')
  const rootId = site.pages[0].rootNodeId
  const nodeId = multiline
    ? useEditorStore.getState().insertNode('base.text', { text: 'Hello' }, rootId)
    : useEditorStore.getState().insertNode('base.button', { label: 'Hello' }, rootId)
  useEditorStore.getState().startInlineEdit(nodeId, 'bp-a')
  return { nodeId }
}

function storedValue(nodeId: string): unknown {
  const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
  return node.props.text ?? node.props.label
}

function queryField(): HTMLTextAreaElement | HTMLInputElement | null {
  return document.querySelector<HTMLTextAreaElement | HTMLInputElement>(FIELD_SELECTOR)
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeInlineEdit: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
  })
})

afterEach(() => {
  cleanup()
})

describe('InlineTextEditOverlay', () => {
  it('renders nothing without a session', () => {
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    expect(queryField()).toBeNull()
  })

  it('renders nothing for a session owned by another frame', () => {
    seedSession()
    render(<InlineTextEditOverlay breakpointId="bp-b" iframeElement={null} />)
    expect(queryField()).toBeNull()
  })

  it('renders a textarea seeded with the current value for multiline sessions', () => {
    seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()
    expect(field?.tagName).toBe('TEXTAREA')
    expect(field?.value).toBe('Hello')
  })

  it('renders an input for single-line sessions', () => {
    seedSession(false)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    expect(queryField()?.tagName).toBe('INPUT')
  })

  it('live-commits every change through the store', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    fireEvent.change(queryField()!, { target: { value: 'Hello world' } })
    expect(storedValue(nodeId)).toBe('Hello world')
    expect(useEditorStore.getState().activeInlineEdit?.committed).toBe(true)
  })

  it('Enter commits and closes (multiline included — base.text renders no newlines)', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()!
    fireEvent.change(field, { target: { value: 'Edited' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(storedValue(nodeId)).toBe('Edited')
  })

  it('Shift+Enter keeps a multiline session open (native newline)', () => {
    seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    fireEvent.keyDown(queryField()!, { key: 'Enter', shiftKey: true })
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
  })

  it('Escape cancels and restores the initial value', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()!
    fireEvent.change(field, { target: { value: 'Mangled' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(storedValue(nodeId)).toBe('Hello')
  })

  it('blur commits and closes', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()!
    fireEvent.change(field, { target: { value: 'Blurred' } })
    fireEvent.blur(field)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(storedValue(nodeId)).toBe('Blurred')
  })

  it('force-closes the session when the frame unmounts mid-session', () => {
    seedSession(true)
    const { unmount } = render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    unmount()
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})
