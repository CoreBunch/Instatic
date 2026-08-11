/**
 * Undo/Redo store tests.
 *
 * History lives in per-doc Y.UndoManagers inside the collab binding
 * (slices/site/collabBinding.ts) — these tests pin down the OBSERVABLE
 * contract through the store: undo/redo operates only on site state,
 * canUndo/canRedo stay accurate, coalescing folds a typing burst into one
 * step, and undo-then-modify clears the redo branch.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
// `startInlineEdit` resolves its `inlineTextEdit` spec from the module registry.
import '@modules/base/text'

// Helper: get fresh store state (Zustand is module-singleton — reset between tests)
function getStore() {
  return useEditorStore.getState()
}

beforeEach(() => {
  // Reset store to a clean slate before each test. clearSite also resets the
  // collab binding's docs + undo managers.
  useEditorStore.getState().clearSite()
  useEditorStore.setState({
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
  })
})

describe('Undo / Redo — basic lifecycle', () => {
  it('canUndo is false before any mutations', () => {
    const store = getStore()
    store.createSite('Test SiteDocument')
    expect(useEditorStore.getState().canUndo).toBe(false)
  })

  it('canUndo becomes true after a mutation', () => {
    const store = getStore()
    const site = store.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    expect(useEditorStore.getState().canUndo).toBe(true)
  })

  it('undo restores previous site state', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const nodesBefore = Object.keys(site.pages[0].nodes).length

    useEditorStore.getState().insertNode('base.text', {}, rootId)
    const nodesAfter = Object.keys(
      useEditorStore.getState().site!.pages[0].nodes
    ).length
    expect(nodesAfter).toBe(nodesBefore + 1)

    useEditorStore.getState().undo()
    const nodesAfterUndo = Object.keys(
      useEditorStore.getState().site!.pages[0].nodes
    ).length
    expect(nodesAfterUndo).toBe(nodesBefore)
  })

  it('redo re-applies the undone mutation', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId

    useEditorStore.getState().insertNode('base.text', {}, rootId)
    const nodesBeforeUndo = Object.keys(
      useEditorStore.getState().site!.pages[0].nodes
    ).length

    useEditorStore.getState().undo()
    useEditorStore.getState().redo()

    const nodesAfterRedo = Object.keys(
      useEditorStore.getState().site!.pages[0].nodes
    ).length
    expect(nodesAfterRedo).toBe(nodesBeforeUndo)
  })

  it('undo prunes selection that points at the reverted insertion', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const insertedId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().selectNode(insertedId)
    expect(useEditorStore.getState().selectedNodeIds).toEqual([insertedId])

    useEditorStore.getState().undo()

    const afterUndo = useEditorStore.getState()
    expect(afterUndo.site!.pages[0].nodes[insertedId]).toBeUndefined()
    expect(afterUndo.selectedNodeIds).toEqual([])
    expect(afterUndo.selectedNodeId).toBeNull()

    const nextId = afterUndo.insertNode('base.text', {}, rootId)
    expect(nextId).not.toBe('')
    expect(useEditorStore.getState().site!.pages[0].nodes[nextId]).toBeDefined()
  })

  it('undo keeps surviving selections and only drops the reverted node', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const survivorId = useEditorStore.getState().insertNode('base.text', {}, rootId)
    const revertedId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().selectNode(survivorId)
    useEditorStore.getState().addToSelection(revertedId)
    expect(useEditorStore.getState().selectedNodeIds).toEqual([survivorId, revertedId])

    // Reverts only the second insertion.
    useEditorStore.getState().undo()

    const afterUndo = useEditorStore.getState()
    expect(afterUndo.site!.pages[0].nodes[revertedId]).toBeUndefined()
    expect(afterUndo.site!.pages[0].nodes[survivorId]).toBeDefined()
    // The survivor keeps its selection; the anchor re-syncs to it rather than
    // the whole multi-selection being cleared.
    expect(afterUndo.selectedNodeIds).toEqual([survivorId])
    expect(afterUndo.selectedNodeId).toBe(survivorId)
  })

  it('undo closes an inline-edit session on the node it reverts', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const breakpointId = site.breakpoints[0]!.id
    const insertedId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().startInlineEdit(insertedId, breakpointId)
    expect(useEditorStore.getState().activeInlineEdit?.nodeId).toBe(insertedId)

    useEditorStore.getState().undo()

    const afterUndo = useEditorStore.getState()
    expect(afterUndo.site!.pages[0].nodes[insertedId]).toBeUndefined()
    // A session pointing at a node that no longer exists must not survive —
    // it is not necessarily part of the selection, so it is pruned by
    // tree-membership.
    expect(afterUndo.activeInlineEdit).toBeNull()
  })

  it('redo prunes selection when replaying a deletion', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const insertedId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().deleteNode(insertedId)
    useEditorStore.getState().undo()
    useEditorStore.getState().selectNode(insertedId)

    useEditorStore.getState().redo()

    const afterRedo = useEditorStore.getState()
    expect(afterRedo.site!.pages[0].nodes[insertedId]).toBeUndefined()
    expect(afterRedo.selectedNodeIds).toEqual([])
    expect(afterRedo.selectedNodeId).toBeNull()
  })

  it('canRedo is true after undo', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().canRedo).toBe(true)
  })

  it('canRedo is false after redo', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().undo()
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().canRedo).toBe(false)
  })

  it('undo clears future when new mutation is made after undo', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId

    // Insert → undo → new insertion (new branch)
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().undo()
    useEditorStore.getState().insertNode('base.text', {}, rootId)

    expect(useEditorStore.getState().canRedo).toBe(false)
  })

  it('multiple mutations are each individually undoable', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const startCount = Object.keys(site.pages[0].nodes).length

    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().insertNode('base.image', {}, rootId)

    expect(Object.keys(useEditorStore.getState().site!.pages[0].nodes).length).toBe(startCount + 3)

    useEditorStore.getState().undo()
    expect(Object.keys(useEditorStore.getState().site!.pages[0].nodes).length).toBe(startCount + 2)

    useEditorStore.getState().undo()
    expect(Object.keys(useEditorStore.getState().site!.pages[0].nodes).length).toBe(startCount + 1)

    useEditorStore.getState().undo()
    expect(Object.keys(useEditorStore.getState().site!.pages[0].nodes).length).toBe(startCount)
  })

  it('undo does nothing when canUndo is false', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const nodesBefore = Object.keys(site.pages[0].nodes).length

    useEditorStore.getState().undo() // no-op
    expect(Object.keys(useEditorStore.getState().site!.pages[0].nodes).length).toBe(nodesBefore)
  })

  it('createSite resets history', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().undo()

    // Create new site — should wipe history
    useEditorStore.getState().createSite('New SiteDocument')
    expect(useEditorStore.getState().canUndo).toBe(false)
    expect(useEditorStore.getState().canRedo).toBe(false)
  })

  it('canvas/UI state (zoom, panX) is not affected by undo', () => {
    const s = getStore()
    const site = s.createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId

    useEditorStore.setState({ zoom: 2, panX: 100, panY: 50 })
    useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().undo()

    const { zoom, panX, panY } = useEditorStore.getState()
    expect(zoom).toBe(2)
    expect(panX).toBe(100)
    expect(panY).toBe(50)
  })
})

describe('Undo / Redo — input coalescing', () => {
  function setupTextNode() {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const nodeId = useEditorStore.getState().insertNode('base.text', { text: '' }, rootId)
    return { nodeId }
  }

  it('coalesces consecutive same-prop edits into one undo entry', () => {
    const { nodeId } = setupTextNode()

    // Simulate per-keystroke typing on a single prop.
    for (const text of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
      useEditorStore.getState().updateNodeProps(nodeId, { text })
    }
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('Hello')

    // A single undo reverts the entire burst back to the pre-typing value —
    // NOT one keystroke — and the node insert stays applied.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('')
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId]).toBeDefined()
  })

  it('does not coalesce edits to different props', () => {
    const { nodeId } = setupTextNode()

    // Capture the module-default tag value BEFORE the edit — different test
    // files may register base.text with different default props.
    const tagBefore = useEditorStore.getState().site!.pages[0].nodes[nodeId].props.tag
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'hi' })
    useEditorStore.getState().updateNodeProps(nodeId, { tag: 'h1' })

    // Different prop keys → two distinct undo entries: the first undo
    // reverts ONLY the tag edit, the text edit survives it.
    useEditorStore.getState().undo()
    let node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.props.tag).toBe(tagBefore)
    expect(node.props.text).toBe('hi')

    useEditorStore.getState().undo()
    node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.props.text).toBe('')
  })

  it('breaks the burst after undo so the next edit is a fresh entry', () => {
    const { nodeId } = setupTextNode()

    useEditorStore.getState().updateNodeProps(nodeId, { text: 'a' })
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'ab' })
    useEditorStore.getState().undo() // back to ''
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('')

    // Typing again must NOT fold into the undone burst: it forms a fresh
    // entry whose undo returns to '' (the post-undo value), and the node
    // insert stays applied.
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'x' })
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('x')
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('')
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId]).toBeDefined()
  })

  it('a non-coalescing mutation ends the burst', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const nodeId = useEditorStore.getState().insertNode('base.text', { text: '' }, rootId)

    useEditorStore.getState().updateNodeProps(nodeId, { text: 'a' })
    // Structural mutation in between resets the coalescing key.
    useEditorStore.getState().insertNode('base.text', { text: '' }, rootId)
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'ab' })

    // 'ab' formed its OWN entry (no folding across the structural break):
    // the first undo reverts only it, back to 'a' — not to ''.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('a')
  })

  it('redo replays a coalesced burst back to its final value', () => {
    const { nodeId } = setupTextNode()
    for (const text of ['H', 'He', 'Hello']) {
      useEditorStore.getState().updateNodeProps(nodeId, { text })
    }
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('')

    useEditorStore.getState().redo()
    // One redo replays the entire burst to its final value, not one keystroke.
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('Hello')
  })
})

describe('Undo / Redo — patch correctness', () => {
  it('undo restores the EXACT prior prop value (not just node count)', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const nodeId = useEditorStore.getState().insertNode('base.text', { text: 'original', tag: 'p' }, rootId)

    // Two distinct, non-coalescing prop edits (different keys → separate entries).
    useEditorStore.getState().updateNodeProps(nodeId, { tag: 'h1' })
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'changed' })

    let node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.props.text).toBe('changed')
    expect(node.props.tag).toBe('h1')

    useEditorStore.getState().undo() // revert text
    node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.props.text).toBe('original')
    expect(node.props.tag).toBe('h1') // unaffected

    useEditorStore.getState().undo() // revert tag
    node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.props.tag).toBe('p')
    expect(node.props.text).toBe('original')
  })

  it('undo/redo round-trips a deep mutation losslessly', () => {
    const site = getStore().createSite('Test SiteDocument')
    const rootId = site.pages[0].rootNodeId
    const a = useEditorStore.getState().insertNode('base.text', { text: 'a' }, rootId)
    const b = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().moveNode(a, b, 0)

    const afterMove = structuredClone(useEditorStore.getState().site!.pages[0].nodes)
    useEditorStore.getState().undo()
    useEditorStore.getState().redo()
    // Deep equality, not string equality — the projection rebuilds node
    // objects from the Y maps, so key ORDER may differ; content must not.
    expect(useEditorStore.getState().site!.pages[0].nodes).toEqual(afterMove)
  })
})
