/**
 * One-outlet-per-document invariant — store-level guards.
 *
 * `insertNode` blocking a second `base.outlet` is covered by
 * `useInsertModule.test.tsx`. These tests cover the OTHER mutation paths that
 * could mint a second outlet without going through `insertNode`:
 *   1. duplicateNode of the outlet itself, and of an ancestor section that
 *      contains it.
 *   2. duplicateNodes (multi-select) — outlet-carrying subtrees are skipped,
 *      the rest still duplicate.
 *   3. pasteNode of a copied payload containing an outlet into a document that
 *      already has one (cross-page copy is the realistic route; same-document
 *      copy + paste reproduces it equally well).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import '@modules/base/index'

function freshStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    clipboardEntry: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)
afterEach(() => {
  localStorage.clear()
})

function countOutlets(): number {
  const state = useEditorStore.getState()
  const page = state.site!.pages.find((p) => p.id === state.activePageId)!
  return Object.values(page.nodes).filter((n) => n.moduleId === 'base.outlet').length
}

describe('outlet invariant — duplicateNode', () => {
  it('refuses to duplicate the outlet node itself', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Outlet Duplicate Test')
    const rootId = site.pages[0].rootNodeId
    const outletId = useEditorStore.getState().insertNode('base.outlet', {}, rootId)
    expect(countOutlets()).toBe(1)

    const newId = useEditorStore.getState().duplicateNode(outletId)
    expect(newId).toBe('')
    expect(countOutlets()).toBe(1)
  })

  it('refuses to duplicate a section whose subtree contains the outlet', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Outlet Section Duplicate Test')
    const rootId = site.pages[0].rootNodeId
    const sectionId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().insertNode('base.outlet', {}, sectionId)
    expect(countOutlets()).toBe(1)

    const newId = useEditorStore.getState().duplicateNode(sectionId)
    expect(newId).toBe('')
    expect(countOutlets()).toBe(1)
  })

  it('still duplicates outlet-free nodes normally', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Plain Duplicate Test')
    const rootId = site.pages[0].rootNodeId
    useEditorStore.getState().insertNode('base.outlet', {}, rootId)
    const textId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    const newId = useEditorStore.getState().duplicateNode(textId)
    expect(newId).toBeTruthy()
    expect(countOutlets()).toBe(1)
  })
})

describe('outlet invariant — duplicateNodes', () => {
  it('skips outlet-carrying subtrees but duplicates the rest of the selection', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Outlet Multi Duplicate Test')
    const rootId = site.pages[0].rootNodeId
    const outletId = useEditorStore.getState().insertNode('base.outlet', {}, rootId)
    const textId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    const newIds = useEditorStore.getState().duplicateNodes([outletId, textId])
    expect(newIds).toHaveLength(1)
    expect(countOutlets()).toBe(1)

    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[newIds[0]].moduleId).toBe('base.text')
  })
})

describe('outlet invariant — pasteNode', () => {
  it('refuses to paste a payload containing an outlet into a document that already has one', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Outlet Paste Test')
    const rootId = site.pages[0].rootNodeId
    const sectionId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().insertNode('base.outlet', {}, sectionId)
    expect(countOutlets()).toBe(1)

    expect(useEditorStore.getState().copyNode(sectionId)).toBe(true)
    const pasted = useEditorStore.getState().pasteNode(rootId)
    expect(pasted).toBeNull()
    expect(countOutlets()).toBe(1)
  })

  it('pastes an outlet payload into a document with no outlet', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Outlet Paste OK Test')
    const rootId = site.pages[0].rootNodeId
    const sectionId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const outletId = useEditorStore.getState().insertNode('base.outlet', {}, sectionId)
    expect(useEditorStore.getState().copyNode(sectionId)).toBe(true)

    // Remove the original — the document no longer holds an outlet.
    useEditorStore.getState().deleteNode(sectionId)
    expect(countOutlets()).toBe(0)
    expect(useEditorStore.getState().site!.pages[0].nodes[outletId]).toBeUndefined()

    const pasted = useEditorStore.getState().pasteNode(rootId)
    expect(pasted).toHaveLength(1)
    expect(countOutlets()).toBe(1)
  })
})
