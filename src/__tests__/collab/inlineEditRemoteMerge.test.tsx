/**
 * Co-typing ONE text node — the headline collab promise ("two admins can
 * co-type one text node simultaneously").
 *
 * The inline-edit surface is a contentEditable that React does not own: it is
 * seeded once at session start and every keystroke commits the element's
 * WHOLE string through `applyInlineEditValue` → `applyTextDiff`. If a remote
 * peer's characters land in the doc mid-session but never reach the frozen
 * surface, the next local keystroke's snapshot diff DELETES them from the
 * CRDT — both replicas converge, to text missing the peer's edit.
 *
 * These tests mount the real canvas (NodeRenderer wiring, iframe portal) and
 * play the remote peer at the Y level, proving the surface merges remote
 * edits mid-session and the next keystroke preserves both intents.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { CanvasTransformLayer } from '@site/canvas/CanvasTransformLayer'
import { useEditorStore } from '@site/store/store'
import { encodeCollabDocId, LOCAL_ORIGIN, seedPageDoc, treeMap } from '@core/collab'
import { collabDocFor } from '@site/store/slices/site/collabBinding'
import {
  attachInlineEditRemoteMerge,
  transformIndexThroughTextDelta,
} from '@site/collab/inlineEditRemoteMerge'
import { seedInlineEditableContent } from '@modules/base/shared/inlineText'
import { waitForCanvasNodeInFrame } from '../canvas/iframeCanvasQuery'
import { makeNode, makePage } from '../fixtures'
import '@modules/base'

const originalFetch = globalThis.fetch

function yTextOf(doc: Y.Doc, nodeId: string): Y.Text {
  const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
  const node = nodes.get(nodeId) as Y.Map<unknown>
  const props = node.get('props') as Y.Map<unknown>
  return props.get('text') as Y.Text
}

function storeText(nodeId: string): unknown {
  const site = useEditorStore.getState().site
  if (!site) return undefined
  for (const page of site.pages) {
    if (page.nodes[nodeId]) return page.nodes[nodeId].props.text
  }
  return undefined
}

beforeEach(() => {
  cleanup()
  document.body.replaceChildren()
  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch
  useEditorStore.getState().clearSite()
})

afterEach(() => {
  cleanup()
  useEditorStore.getState().clearSite()
  document.body.replaceChildren()
  globalThis.fetch = originalFetch
})

/** Create a real site via store actions (keeps the detached collab docs
 * aligned), insert a text node, and mount the canvas on the desktop frame. */
async function setupEditingSession(initialText: string): Promise<{
  nodeId: string
  pageId: string
  editable: HTMLElement
  local: Y.Doc
}> {
  const store = useEditorStore.getState()
  store.createSite('Co-typing')
  const pageId = useEditorStore.getState().activePageId!
  const page = useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!
  const nodeId = useEditorStore
    .getState()
    .insertNode('base.text', { text: initialText }, page.rootNodeId)

  render(
    <CanvasTransformLayer
      page={useEditorStore.getState().site!.pages.find((p) => p.id === pageId)!}
      breakpoints={useEditorStore.getState().site!.breakpoints}
      activeBreakpointId="desktop"
      onBreakpointActivate={() => {}}
    />,
  )
  await waitForCanvasNodeInFrame('desktop', nodeId)

  await act(async () => {
    useEditorStore.getState().startInlineEdit(nodeId, 'desktop')
  })
  const editable = await waitForCanvasNodeInFrame('desktop', nodeId)
  await waitFor(() => expect(editable.getAttribute('contenteditable')).toBeTruthy())
  expect(editable.textContent).toBe(initialText)

  const local = collabDocFor(encodeCollabDocId({ kind: 'page', rowId: pageId }))!
  expect(local).toBeTruthy()
  return { nodeId, pageId, editable, local }
}

/** Clone the local doc into a peer replica, mutate its Y.Text, sync back. */
async function remoteTextEdit(
  local: Y.Doc,
  nodeId: string,
  edit: (text: Y.Text) => void,
): Promise<Y.Doc> {
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
  edit(yTextOf(remote, nodeId))
  await act(async () => {
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)))
    // Flush the projection microtask so the store catches up too.
    await Promise.resolve()
  })
  return remote
}

describe('co-typing one text node (remote merge into the inline-edit surface)', () => {
  it('a remote peer edit lands in the editing surface and survives the next local keystroke', async () => {
    const { nodeId, editable, local } = await setupEditingSession('hello')

    // Remote peer appends " world" while the local session is open.
    const remote = await remoteTextEdit(local, nodeId, (t) => t.insert(5, ' world'))

    // The store projected the remote edit (this always worked)...
    expect(storeText(nodeId)).toBe('hello world')
    // ...and the SESSION SURFACE shows it too. A frozen surface here means the
    // next keystroke's whole-string snapshot diff deletes " world" from the CRDT.
    expect(editable.textContent).toBe('hello world')

    // Local user keeps typing: append "!".
    editable.textContent = `${editable.textContent}!`
    fireEvent.input(editable)

    // Intent preservation: BOTH edits survive, on every replica.
    expect(yTextOf(local, nodeId).toString()).toBe('hello world!')
    expect(storeText(nodeId)).toBe('hello world!')
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local, Y.encodeStateVector(remote)))
    expect(yTextOf(remote, nodeId).toString()).toBe('hello world!')
  })

  it('interleaved co-typing keeps every character from both peers', async () => {
    const { nodeId, editable, local } = await setupEditingSession('ab')

    // Peer prepends "X" — local surface must become "Xab".
    const remote = await remoteTextEdit(local, nodeId, (t) => t.insert(0, 'X'))
    expect(editable.textContent).toBe('Xab')

    // Local types "!" at the end.
    editable.textContent = `${editable.textContent}!`
    fireEvent.input(editable)
    expect(yTextOf(local, nodeId).toString()).toBe('Xab!')

    // Peer deletes its own "X" concurrently with another local keystroke.
    await remoteTextEdit(local, nodeId, (t) => t.delete(0, 1))
    expect(editable.textContent).toBe('ab!')
    editable.textContent = `${editable.textContent}?`
    fireEvent.input(editable)
    expect(yTextOf(local, nodeId).toString()).toBe('ab!?')
    expect(storeText(nodeId)).toBe('ab!?')
    // The first remote replica converges to the same text.
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local, Y.encodeStateVector(remote)))
    expect(yTextOf(remote, nodeId).toString()).toBe('ab!?')
  })
})

describe('transformIndexThroughTextDelta', () => {
  it('shifts the caret right past inserts at or before it', () => {
    // "hello" → "Xhello": caret 3 → 4.
    expect(transformIndexThroughTextDelta([{ insert: 'X' }], 3)).toBe(4)
    // Insert exactly AT the caret pushes it right (Y relative-position rule).
    expect(transformIndexThroughTextDelta([{ retain: 3 }, { insert: 'ab' }], 3)).toBe(5)
    // Insert after the caret leaves it alone.
    expect(transformIndexThroughTextDelta([{ retain: 4 }, { insert: 'z' }], 3)).toBe(3)
  })

  it('shifts the caret left past deletes before it and clamps inside a spanning delete', () => {
    // Delete [0,2) with caret at 3 → 1.
    expect(transformIndexThroughTextDelta([{ delete: 2 }], 3)).toBe(1)
    // Delete [1,4) spans the caret at 2 → collapses to the delete start (1).
    expect(transformIndexThroughTextDelta([{ retain: 1 }, { delete: 3 }], 2)).toBe(1)
    // Delete at/after the caret leaves it alone.
    expect(transformIndexThroughTextDelta([{ retain: 3 }, { delete: 2 }], 3)).toBe(3)
  })

  it('composes mixed op sequences', () => {
    // "hello world" → "hi world!": caret after "hello" (5).
    const delta = [{ retain: 1 }, { delete: 4 }, { insert: 'i' }, { retain: 6 }, { insert: '!' }]
    expect(transformIndexThroughTextDelta(delta, 5)).toBe(2)
  })
})

describe('attachInlineEditRemoteMerge (surface-level)', () => {
  function seededSurface(text: string, nodeId = 't1') {
    const doc = new Y.Doc()
    seedPageDoc(
      doc,
      makePage({
        id: 'p1',
        rootNodeId: 'root',
        nodes: {
          root: makeNode({ id: 'root', moduleId: 'base.body', children: [nodeId] }),
          [nodeId]: makeNode({ id: nodeId, moduleId: 'base.text', props: { text, tag: 'p' } }),
        },
      }),
    )
    const el = document.createElement('p')
    document.body.appendChild(el)
    seedInlineEditableContent(el, text)
    const detach = attachInlineEditRemoteMerge({ el, doc, nodeId, prop: 'text' })
    return { doc, el, nodeId, detach }
  }

  function remoteInsert(doc: Y.Doc, nodeId: string, index: number, value: string): void {
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
    yTextOf(remote, nodeId).insert(index, value)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)))
  }

  it('preserves the local caret across a remote insert before it — with <br> line breaks', () => {
    const { doc, el, nodeId, detach } = seededSurface('ab\ncd')
    // Children: "ab", <br>, "cd" — caret between "c" and "d" (absolute offset 4).
    const cdNode = el.childNodes[2]
    const range = document.createRange()
    range.setStart(cdNode, 1)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    remoteInsert(doc, nodeId, 0, 'Z')

    expect(el.innerHTML).toBe('Zab<br>cd')
    // Caret followed its character: still between "c" and "d".
    expect(selection.anchorNode?.textContent).toBe('cd')
    expect(selection.anchorOffset).toBe(1)
    detach()
  })

  it('ignores LOCAL_ORIGIN transactions (the DOM is where those came from)', () => {
    const { doc, el, nodeId, detach } = seededSurface('hello')
    // A local applyTextDiff-style write: the surface already shows it, so the
    // merge must not touch the DOM (a rewrite would collapse the caret).
    el.appendChild(el.ownerDocument.createTextNode('!'))
    const marker = el.firstChild
    doc.transact(() => {
      yTextOf(doc, nodeId).insert(5, '!')
    }, LOCAL_ORIGIN)
    expect(el.firstChild).toBe(marker) // untouched — no rewrite happened
    expect(el.textContent).toBe('hello!')
    detach()
  })

  it('defers the merge during IME composition and applies it on compositionend', () => {
    const { doc, el, nodeId, detach } = seededSurface('hello')
    el.dispatchEvent(new Event('compositionstart'))
    remoteInsert(doc, nodeId, 5, ' world')
    expect(el.textContent).toBe('hello') // frozen mid-composition
    el.dispatchEvent(new Event('compositionend'))
    expect(el.textContent).toBe('hello world')
    detach()
  })

  it('stops merging after detach', () => {
    const { doc, el, nodeId, detach } = seededSurface('hello')
    detach()
    remoteInsert(doc, nodeId, 0, 'X')
    expect(el.textContent).toBe('hello')
  })
})
