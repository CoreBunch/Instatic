/**
 * CRDT merge scenarios — two docs exchanging updates must converge with the
 * GRANULARITY the product promises: different nodes never collide, different
 * props of one node never collide, and the inline-text prop merges
 * character-level. `applyTextDiff` is the minimal-splice bridge between
 * contentEditable string snapshots and Y.Text operations.
 */
import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import { applyTextDiff, projectPageDoc, seedPageDoc, treeMap } from '@core/collab'
import { makeNode, makePage } from '../fixtures'

function fixturePage() {
  return makePage({
    id: 'p1',
    slug: 'index',
    title: 'Home',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['t1', 'c1'] }),
      t1: makeNode({ id: 't1', moduleId: 'base.text', props: { text: 'hello world', tag: 'p' } }),
      c1: makeNode({ id: 'c1', moduleId: 'base.container', children: [] }),
    },
  })
}

/** Seed once, clone into a second doc — the shared-history starting point. */
function seededPair(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc()
  seedPageDoc(a, fixturePage())
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  return [a, b]
}

function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

function nodeMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  return (treeMap(doc).get('nodes') as Y.Map<unknown>).get(id) as Y.Map<unknown>
}

describe('granular merge', () => {
  it('concurrent edits to different props of the same node both survive', () => {
    const [a, b] = seededPair()
    ;(nodeMap(a, 't1').get('props') as Y.Map<unknown>).set('tag', 'h1')
    ;(nodeMap(b, 't1').get('props') as Y.Map<unknown>).set('align', 'center')
    syncDocs(a, b)
    for (const doc of [a, b]) {
      const projected = projectPageDoc(doc, 'p1')
      expect(projected.nodes.t1.props.tag).toBe('h1')
      expect(projected.nodes.t1.props.align).toBe('center')
    }
  })

  it('concurrent Y.Text typing merges character-level and identically on both peers', () => {
    const [a, b] = seededPair()
    const textA = (nodeMap(a, 't1').get('props') as Y.Map<unknown>).get('text') as Y.Text
    const textB = (nodeMap(b, 't1').get('props') as Y.Map<unknown>).get('text') as Y.Text
    textA.insert(0, 'A: ')            // prepend on peer A
    textB.insert(textB.length, ' :B') // append on peer B
    syncDocs(a, b)
    const merged = textA.toString()
    expect(merged).toContain('A: ')
    expect(merged).toContain(' :B')
    expect(merged).toContain('hello world')
    expect(textB.toString()).toBe(merged)
  })

  it('concurrent child insert + child delete converge and reconcile identically', () => {
    const [a, b] = seededPair()
    a.transact(() => {
      const nodes = treeMap(a).get('nodes') as Y.Map<unknown>
      const fresh = new Y.Map<unknown>()
      fresh.set('id', 'n2')
      fresh.set('moduleId', 'base.container')
      fresh.set('props', new Y.Map())
      fresh.set('breakpointOverrides', new Y.Map())
      fresh.set('children', new Y.Array())
      nodes.set('n2', fresh)
      const rootChildren = (nodes.get('root') as Y.Map<unknown>).get('children') as Y.Array<string>
      rootChildren.insert(rootChildren.length, ['n2'])
    })
    b.transact(() => {
      const nodes = treeMap(b).get('nodes') as Y.Map<unknown>
      nodes.delete('c1')
      const rootChildren = (nodes.get('root') as Y.Map<unknown>).get('children') as Y.Array<string>
      rootChildren.delete(1, 1) // remove 'c1'
    })
    syncDocs(a, b)
    const pa = projectPageDoc(a, 'p1')
    const pb = projectPageDoc(b, 'p1')
    expect(pa.nodes.root.children).toEqual(pb.nodes.root.children)
    expect(pa.nodes.root.children).toContain('n2')
    expect(pa.nodes.root.children).not.toContain('c1')
  })
})

describe('applyTextDiff', () => {
  it('applies a minimal middle splice', () => {
    const t = new Y.Doc().getText('t')
    t.insert(0, 'hello world')
    applyTextDiff(t, 'hello world', 'hello brave world')
    expect(t.toString()).toBe('hello brave world')
  })

  it('handles pure insertion, pure deletion, and full replacement', () => {
    const t = new Y.Doc().getText('t')
    t.insert(0, 'abc')
    applyTextDiff(t, 'abc', 'abXc')
    expect(t.toString()).toBe('abXc')
    applyTextDiff(t, 'abXc', 'ac')
    expect(t.toString()).toBe('ac')
    applyTextDiff(t, 'ac', 'zz')
    expect(t.toString()).toBe('zz')
  })

  it('no-ops on identical strings (no spurious Y operations)', () => {
    const doc = new Y.Doc()
    const t = doc.getText('t')
    t.insert(0, 'same')
    const before = Y.encodeStateVector(doc)
    applyTextDiff(t, 'same', 'same')
    expect(Y.encodeStateVector(doc)).toEqual(before)
  })

  it('keeps a concurrent remote insertion when splicing (the granularity proof)', () => {
    const a = new Y.Doc()
    a.getText('t').insert(0, 'hello world')
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // A splices via diff (panel edit), B types at the end concurrently.
    applyTextDiff(a.getText('t'), 'hello world', 'hello brave world')
    b.getText('t').insert(11, '!!')
    syncDocs(a, b)
    const merged = a.getText('t').toString()
    expect(merged).toContain('brave')
    expect(merged).toContain('!!')
    expect(b.getText('t').toString()).toBe(merged)
  })
})

describe('wire frame codec', () => {
  it('round-trips docId + frameType + payload', async () => {
    const { encodeCollabFrame, decodeCollabFrame, FRAME_SYNC } = await import('@core/collab')
    const frame = encodeCollabFrame('page:p1', FRAME_SYNC, new Uint8Array([1, 2, 3]))
    const decoded = decodeCollabFrame(frame)
    expect([decoded.docId, decoded.frameType, [...decoded.payload]]).toEqual([
      'page:p1',
      FRAME_SYNC,
      [1, 2, 3],
    ])
  })

  it('round-trips an empty payload (reset frames)', async () => {
    const { encodeCollabFrame, decodeCollabFrame, FRAME_RESET } = await import('@core/collab')
    const decoded = decodeCollabFrame(encodeCollabFrame('site:default', FRAME_RESET, new Uint8Array()))
    expect(decoded.docId).toBe('site:default')
    expect(decoded.frameType).toBe(FRAME_RESET)
    expect(decoded.payload.length).toBe(0)
  })
})
