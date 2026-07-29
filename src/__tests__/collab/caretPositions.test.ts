/**
 * Caret codec — base64 relative positions round-trip through a Y.Text and
 * stay CORRECT under concurrent edits (the reason plain indices don't work).
 */
import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import { treeMap } from '@core/collab'
import {
  encodeCaretRange,
  resolveCaretRange,
} from '@site/collab/caretPositions'

function docWithText(initial: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc()
  const text = new Y.Text(initial)
  doc.transact(() => {
    const nodes = new Y.Map<unknown>()
    const node = new Y.Map<unknown>()
    const props = new Y.Map<unknown>()
    props.set('text', text)
    node.set('props', props)
    nodes.set('n1', node)
    treeMap(doc).set('nodes', nodes)
  })
  return { doc, text }
}

describe('caretPositions', () => {
  it('round-trips offsets through encode → resolve', () => {
    const { doc } = docWithText('Hello world')
    const caret = encodeCaretRange(doc, 'n1', 'text', 6, 11)
    expect(caret).not.toBeNull()
    expect(resolveCaretRange(doc, caret!)).toEqual({ anchor: 6, head: 11 })
  })

  it('positions survive a concurrent insert BEFORE the caret', () => {
    const { doc, text } = docWithText('Hello world')
    const caret = encodeCaretRange(doc, 'n1', 'text', 6, 6) // before "world"
    text.insert(0, '>>> ') // concurrent edit shifts everything right
    expect(resolveCaretRange(doc, caret!)).toEqual({ anchor: 10, head: 10 })
  })

  it('returns null for a non-Y.Text prop and for malformed wire data', () => {
    const doc = new Y.Doc()
    expect(encodeCaretRange(doc, 'missing', 'text', 0, 0)).toBeNull()
    const { doc: ok } = docWithText('abc')
    expect(
      resolveCaretRange(ok, { nodeId: 'n1', prop: 'text', anchor: '!!notbase64', head: '!!' }),
    ).toBeNull()
  })
})
