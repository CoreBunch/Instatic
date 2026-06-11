/**
 * VC slot-reconcile gate — the site-wide `syncAllVCRefSlotInstances` sweep
 * after a VC-mode mutation runs ONLY when the VC's ordered slot-outlet name
 * sequence actually changed.
 *
 * Skip side (perf contract): a mutation that does not touch the outlet
 * sequence (per-keystroke prop edits, duplicating a non-outlet node) must
 * leave every consumer tree untouched — asserted by OBJECT IDENTITY on
 * `site.pages`, which the old unconditional sweep broke by rewriting each
 * consumer ref's `children` array on every keystroke.
 *
 * Sweep side (behavior pins): outlet rename, reorder (sequence ≠ set — a
 * set-equality gate would skip this one!), insert, and delete must still
 * propagate to consumer slot-instances exactly as before.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
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

/**
 * Load a site with VC `vc-1` (two slot-outlets 'a' + 'b' and a text node)
 * consumed by page `p1` via `ref-1` with matching materialized
 * slot-instances, then enter VC-canvas mode on `vc-1`.
 */
function loadVCEditingSite(): void {
  const vc = makeVC({
    id: 'vc-1',
    name: 'Hero',
    tree: makeVCTree('vc-root', [
      makeVCNode({ id: 'vc-root', moduleId: 'base.body', children: ['outlet-a', 'outlet-b', 'vc-text'] }),
      makeVCNode({ id: 'outlet-a', moduleId: 'base.slot-outlet', props: { slotName: 'a' } }),
      makeVCNode({ id: 'outlet-b', moduleId: 'base.slot-outlet', props: { slotName: 'b' } }),
      makeVCNode({ id: 'vc-text', moduleId: 'base.text', props: { text: 'hello' } }),
    ]),
  })
  const page = makePage({
    id: 'p1',
    rootNodeId: 'root',
    nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref-1'] }),
      'ref-1': makeNode({
        id: 'ref-1',
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-1', propOverrides: {} },
        children: ['inst-a', 'inst-b'],
      }),
      'inst-a': makeNode({ id: 'inst-a', moduleId: 'base.slot-instance', props: { slotName: 'a' }, locked: true }),
      'inst-b': makeNode({ id: 'inst-b', moduleId: 'base.slot-instance', props: { slotName: 'b' }, locked: true }),
    },
  })
  useEditorStore.getState().loadSite(makeSite({ pages: [page], visualComponents: [vc] }))
  useEditorStore.setState({
    activePageId: 'p1',
    activeDocument: { kind: 'visualComponent', vcId: 'vc-1' },
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  freshStore()
  loadVCEditingSite()
})

describe('VC slot-reconcile gate — sweep is skipped when outlets are unchanged', () => {
  it('a non-outlet prop edit leaves consumer pages untouched (object identity)', () => {
    const pagesBefore = useEditorStore.getState().site!.pages

    useEditorStore.getState().updateNodeProps('vc-text', { text: 'world' })

    const after = useEditorStore.getState().site!
    expect(after.visualComponents[0].tree.nodes['vc-text'].props.text).toBe('world')
    // No sweep → no consumer tree was drafted → structural sharing keeps the
    // exact same pages array (and page objects).
    expect(after.pages).toBe(pagesBefore)
    expect(after.pages[0]).toBe(pagesBefore[0])
  })

  it('duplicating a non-outlet node (mutateActiveTreeAndSite path) leaves consumer pages untouched', () => {
    const pagesBefore = useEditorStore.getState().site!.pages

    const dupId = useEditorStore.getState().duplicateNode('vc-text')
    expect(dupId).toBeTruthy()

    const after = useEditorStore.getState().site!
    expect(after.visualComponents[0].tree.nodes[dupId]).toBeDefined()
    expect(after.pages).toBe(pagesBefore)
  })

  it('undo of a skipped-sweep edit restores the VC tree', () => {
    useEditorStore.getState().updateNodeProps('vc-text', { text: 'world' })
    useEditorStore.getState().undo()
    expect(
      useEditorStore.getState().site!.visualComponents[0].tree.nodes['vc-text'].props.text,
    ).toBe('hello')
  })
})

describe('VC slot-reconcile gate — sweep still runs on outlet changes', () => {
  it('renaming an outlet (per-keystroke slotName prop edit) renames consumer slot-instances', () => {
    useEditorStore.getState().updateNodeProps('outlet-a', { slotName: 'hero' })

    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes['inst-a'].props.slotName).toBe('hero')
    expect(page.nodes['inst-b'].props.slotName).toBe('b')
  })

  it('reordering outlets reorders consumer slot-instances (sequence change, set unchanged)', () => {
    useEditorStore.getState().moveNode('outlet-b', 'vc-root', 0)

    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes['ref-1'].children).toEqual(['inst-b', 'inst-a'])
  })

  it('deleting an outlet cascade-deletes the consumer slot-instance', () => {
    useEditorStore.getState().deleteNode('outlet-b')

    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes['ref-1'].children).toEqual(['inst-a'])
    expect(page.nodes['inst-b']).toBeUndefined()
  })

  it('inserting an outlet materializes a new consumer slot-instance', () => {
    useEditorStore.getState().insertNode('base.slot-outlet', { slotName: 'c' }, 'vc-root')

    const page = useEditorStore.getState().site!.pages[0]
    const ref = page.nodes['ref-1']
    expect(ref.children).toHaveLength(3)
    const newInst = page.nodes[ref.children[2]]
    expect(newInst.moduleId).toBe('base.slot-instance')
    expect(newInst.props.slotName).toBe('c')
  })
})
