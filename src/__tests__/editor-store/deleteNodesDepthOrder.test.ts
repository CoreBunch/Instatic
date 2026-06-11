/**
 * depthInTree + deleteNodes batch ordering.
 *
 * `depthInTree` walks the O(1) `parentId` pointer chain (no node-map scans).
 * These tests pin its semantics — root depth 0, parent-chain depth, Infinity
 * for orphans/missing ids — and the `deleteNodes` contract built on it:
 * depths are precomputed against the frozen pre-mutation tree, leaves are
 * deleted before parents, and a batch containing a parent plus its
 * descendants lands in ONE undo entry with no throw.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { depthInTree } from '@site/store/slices/site/helpers'
import { makeNode, makePage, makeSite, makeVC, makeVCNode, makeVCTree } from '../fixtures'
import '@modules/base/index'

function freshStore(): void {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

describe('depthInTree', () => {
  // makePage runs reindexNodeParents, mirroring every real load boundary.
  const page = makePage({
    id: 'p1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['a'] }),
      a: makeNode({ id: 'a', moduleId: 'base.container', children: ['b'] }),
      b: makeNode({ id: 'b', moduleId: 'base.container', children: ['c'] }),
      c: makeNode({ id: 'c', moduleId: 'base.text' }),
      orphan: makeNode({ id: 'orphan', moduleId: 'base.text' }),
    },
  })

  it('returns 0 for the root node', () => {
    expect(depthInTree(page, 'root')).toBe(0)
  })

  it('returns the parent-chain length for nested nodes', () => {
    expect(depthInTree(page, 'a')).toBe(1)
    expect(depthInTree(page, 'b')).toBe(2)
    expect(depthInTree(page, 'c')).toBe(3)
  })

  it('returns Infinity for a node detached from the root', () => {
    expect(depthInTree(page, 'orphan')).toBe(Infinity)
  })

  it('returns Infinity for an id not present in the tree', () => {
    expect(depthInTree(page, 'no-such-node')).toBe(Infinity)
  })
})

describe('deleteNodes — batch ordering and routing', () => {
  it('deletes a parent listed BEFORE its descendants without throwing, in one undo entry', () => {
    const site = useEditorStore.getState().createSite('Batch')
    const rootId = site.pages[0].rootNodeId
    const container = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const childA = useEditorStore.getState().insertNode('base.text', { text: 'a' }, container)
    const childB = useEditorStore.getState().insertNode('base.text', { text: 'b' }, container)
    const sibling = useEditorStore.getState().insertNode('base.text', { text: 's' }, rootId)
    const baseline = Object.keys(useEditorStore.getState().site!.pages[0].nodes).length
    const depthBefore = useEditorStore.getState()._historyPast.length

    // Parent first — depth-DESC ordering must delete the leaves first so the
    // already-deleted descendants hit the "node not found" guard cleanly.
    useEditorStore.getState().deleteNodes([container, childA, childB, sibling])

    const nodes = useEditorStore.getState().site!.pages[0].nodes
    expect(nodes[container]).toBeUndefined()
    expect(nodes[childA]).toBeUndefined()
    expect(nodes[childB]).toBeUndefined()
    expect(nodes[sibling]).toBeUndefined()
    expect(Object.keys(nodes).length).toBe(baseline - 4)
    expect(useEditorStore.getState()._historyPast.length).toBe(depthBefore + 1)

    // One undo restores the whole batch.
    useEditorStore.getState().undo()
    const restored = useEditorStore.getState().site!.pages[0].nodes
    expect(Object.keys(restored).length).toBe(baseline)
    expect(restored[container]).toBeDefined()
    expect(restored[childA]).toBeDefined()
  })

  it('skips the root id and unknown ids while deleting the rest', () => {
    const site = useEditorStore.getState().createSite('Batch')
    const rootId = site.pages[0].rootNodeId
    const text = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().deleteNodes([rootId, 'no-such-node', text])

    const nodes = useEditorStore.getState().site!.pages[0].nodes
    expect(nodes[rootId]).toBeDefined()
    expect(nodes[text]).toBeUndefined()
  })

  it('is a history no-op when no listed id exists in the tree', () => {
    useEditorStore.getState().createSite('Batch')
    const depthBefore = useEditorStore.getState()._historyPast.length

    useEditorStore.getState().deleteNodes(['ghost-1', 'ghost-2'])

    expect(useEditorStore.getState()._historyPast.length).toBe(depthBefore)
  })

  it('routes to the active VC tree in VC mode', () => {
    const vc = makeVC({
      id: 'vc-1',
      name: 'Card',
      tree: makeVCTree('vc-root', [
        makeVCNode({ id: 'vc-root', moduleId: 'base.body', children: ['vc-box'] }),
        makeVCNode({ id: 'vc-box', moduleId: 'base.container', children: ['vc-text'] }),
        makeVCNode({ id: 'vc-text', moduleId: 'base.text', props: { text: 'hi' } }),
      ]),
    })
    useEditorStore.getState().loadSite(makeSite({ pages: [makePage({ id: 'p1' })], visualComponents: [vc] }))
    useEditorStore.setState({
      activePageId: 'p1',
      activeDocument: { kind: 'visualComponent', vcId: 'vc-1' },
    } as Parameters<typeof useEditorStore.setState>[0])

    // Parent before child again — exercises depth ordering against the VC tree.
    useEditorStore.getState().deleteNodes(['vc-box', 'vc-text'])

    const tree = useEditorStore.getState().site!.visualComponents[0].tree
    expect(tree.nodes['vc-box']).toBeUndefined()
    expect(tree.nodes['vc-text']).toBeUndefined()
    expect(tree.nodes['vc-root']).toBeDefined()
    expect(tree.nodes['vc-root'].children).toEqual([])
  })
})
