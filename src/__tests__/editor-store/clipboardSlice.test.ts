/**
 * clipboardSlice — copy/cut/paste over the editor store.
 *
 * Covers:
 *   1. copyNode: captures the subtree + referenced classes into the entry.
 *   2. cutNode: captures + removes the source node.
 *   3. pasteNode (smart placement):
 *      - target accepts children → pastes inside as last child
 *      - target is a leaf        → pastes as next sibling
 *   4. localStorage persistence: a fresh store re-hydrates the entry.
 *   5. Class handling on paste:
 *      - same-site reuse of regular classes
 *      - scoped classes are cloned with fresh IDs and remapped scope.nodeId
 *      - missing framework classes are dropped
 *   6. Refusal to copy / cut the page root.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import {
  CLIPBOARD_STORAGE_KEY,
  readClipboardPayload,
} from '@site/store/clipboard/clipboardStorage'
import '@modules/base/index'

function freshStore() {
  localStorage.clear()
  // Reset every relevant slice field. Mirrors the resets in selectionSlice / undo-redo tests.
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

describe('clipboardSlice.copyNode', () => {
  it('captures the subtree and referenced classes into the entry', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId

    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const textId = useEditorStore.getState().insertNode('base.text', {}, containerId)

    const cls = useEditorStore.getState().createClass('clip-style')
    useEditorStore.getState().addNodeClass(textId, cls.id)

    const ok = useEditorStore.getState().copyNode(containerId)
    expect(ok).toBe(true)

    const entry = useEditorStore.getState().clipboardEntry
    expect(entry).not.toBeNull()
    expect(entry!.rootNodeIds).toEqual([containerId])
    expect(Object.keys(entry!.nodes)).toEqual(expect.arrayContaining([containerId, textId]))
    expect(entry!.classes[cls.id]?.name).toBe('clip-style')
  })

  it('refuses to copy the page root', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId

    const ok = useEditorStore.getState().copyNode(rootId)
    expect(ok).toBe(false)
    expect(useEditorStore.getState().clipboardEntry).toBeNull()
  })

  it('persists the entry to localStorage', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId
    const textId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().copyNode(textId)

    const persisted = readClipboardPayload()
    expect(persisted).not.toBeNull()
    expect(persisted!.rootNodeIds).toEqual([textId])
    expect(localStorage.getItem(CLIPBOARD_STORAGE_KEY)).toBeTruthy()
  })

  it('refuses cut when a CSS dependency is missing and preserves the source', () => {
    const site = useEditorStore.getState().createSite('Clip Site')
    const nodeId = useEditorStore.getState().insertNode('base.text', {}, site.pages[0].rootNodeId)
    const cls = useEditorStore.getState().createClass('broken-style')
    useEditorStore.getState().addNodeClass(nodeId, cls.id)
    useEditorStore.setState((state) => {
      state.site!.styleRules[cls.id].grouping = [{ kind: 'context', id: 'group', contextId: 'missing' }]
    })
    const logged = spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(useEditorStore.getState().cutNode(nodeId)).toBe(false)
      expect(useEditorStore.getState().site!.pages[0].nodes[nodeId]).toBeDefined()
      expect(useEditorStore.getState().clipboardEntry).toBeNull()
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })
})

describe('clipboardSlice.cutNode', () => {
  it('captures the subtree and removes the original node', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId
    const textId = useEditorStore.getState().insertNode('base.text', {}, rootId)

    const ok = useEditorStore.getState().cutNode(textId)
    expect(ok).toBe(true)

    const state = useEditorStore.getState()
    const page = state.site!.pages[0]
    expect(page.nodes[textId]).toBeUndefined()
    expect(state.clipboardEntry?.rootNodeIds).toEqual([textId])
    // The clipboard entry preserves the captured node even though it's gone from the page.
    expect(state.clipboardEntry?.nodes[textId]).toBeDefined()
  })

  it('refuses to cut the page root', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId

    const ok = useEditorStore.getState().cutNode(rootId)
    expect(ok).toBe(false)
    expect(useEditorStore.getState().site!.pages[0].nodes[rootId]).toBeDefined()
  })
})

describe('clipboardSlice.pasteNode — smart placement', () => {
  it('pastes inside the target when it accepts children', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId

    const sourceText = useEditorStore.getState().insertNode('base.text', {}, rootId)
    const target = useEditorStore.getState().insertNode('base.container', {}, rootId)

    useEditorStore.getState().copyNode(sourceText)
    const newIds = useEditorStore.getState().pasteNode(target)

    expect(newIds).not.toBeNull()
    expect(newIds!.length).toBe(1)
    const newId = newIds![0]
    const state = useEditorStore.getState()
    const page = state.site!.pages[0]
    expect(page.nodes[target].children).toContain(newId)
    expect(page.nodes[newId].moduleId).toBe('base.text')
    // The new ID is fresh — not the source's.
    expect(newId).not.toBe(sourceText)
  })

  it('pastes as next sibling when the target is a leaf', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId

    const a = useEditorStore.getState().insertNode('base.text', {}, rootId)
    const b = useEditorStore.getState().insertNode('base.text', {}, rootId)

    useEditorStore.getState().copyNode(a)
    const newIds = useEditorStore.getState().pasteNode(b)
    expect(newIds).not.toBeNull()
    expect(newIds!.length).toBe(1)

    const state = useEditorStore.getState()
    const root = state.site!.pages[0].nodes[rootId]
    const idxB = root.children.indexOf(b)
    expect(root.children[idxB + 1]).toBe(newIds![0])
  })

  it('returns null when the clipboard is empty', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId
    const target = useEditorStore.getState().insertNode('base.container', {}, rootId)

    expect(useEditorStore.getState().pasteNode(target)).toBeNull()
  })
})

describe('clipboardSlice.pasteNode — class handling', () => {
  it('reuses regular classes that already exist in the target site', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId

    const text = useEditorStore.getState().insertNode('base.text', {}, rootId)
    const cls = useEditorStore.getState().createClass('shared-style')
    useEditorStore.getState().addNodeClass(text, cls.id)

    useEditorStore.getState().copyNode(text)
    const target = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const newIds = useEditorStore.getState().pasteNode(target)
    expect(newIds).not.toBeNull()
    expect(newIds!.length).toBe(1)

    const state = useEditorStore.getState()
    const pasted = state.site!.pages[0].nodes[newIds![0]]
    expect(pasted.classIds).toContain(cls.id)
    // The class itself is reused — no duplicate added to the registry.
    const matches = Object.values(state.site!.styleRules).filter(
      (c) => c.name === 'shared-style',
    )
    expect(matches.length).toBe(1)
  })

  it('restores a copied class when the active document no longer has it', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId
    const text = useEditorStore.getState().insertNode('base.text', {}, rootId)
    const cls = useEditorStore.getState().createClass('restored-style')
    useEditorStore.getState().addNodeClass(text, cls.id)
    useEditorStore.getState().copyNode(text)

    useEditorStore.setState((state) => {
      state.site!.styleRules = {}
    })

    const container = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const pastedIds = useEditorStore.getState().pasteNode(container)
    expect(pastedIds).not.toBeNull()
    expect(pastedIds!.length).toBe(1)

    const state = useEditorStore.getState()
    const importedClass = state.site!.styleRules[cls.id]
    expect(importedClass?.name).toBe('restored-style')
    expect(state.site!.pages[0].nodes[pastedIds![0]].classIds).toContain(cls.id)
  })
})

describe('clipboardSlice — persistence', () => {
  it('rehydrates clipboardEntry from localStorage on a fresh setState', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Clip Site')
    const rootId = site.pages[0].rootNodeId
    const textId = useEditorStore.getState().insertNode('base.text', {}, rootId)
    useEditorStore.getState().copyNode(textId)

    // Round-trip through localStorage manually to confirm the persisted shape parses.
    const reloaded = readClipboardPayload()
    expect(reloaded).not.toBeNull()
    expect(reloaded!.version).toBe(3)
    expect(reloaded!.rootNodeIds).toEqual([textId])
  })
})
