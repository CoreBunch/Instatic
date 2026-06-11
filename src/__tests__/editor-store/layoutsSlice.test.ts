/**
 * layoutsSlice — save / insert / rename / delete of user-saved layouts.
 *
 * Covers:
 *   1. saveNodeAsLayout: captures the subtree + referenced classes onto
 *      site.layouts (and marks the layout dirty for save).
 *   2. Guards: page root refused; duplicate names throw SavedLayoutNameError.
 *   3. insertLayout: exact structure restoration with fresh node ids
 *      (paste semantics — props, classIds, child order survive).
 *   4. Scoped classes are cloned with fresh IDs and remapped scope.nodeId.
 *   5. One-outlet-per-document guard on insert.
 *   6. Dangling VC refs in a snapshot are stripped at insertion time.
 *   7. renameLayout / deleteLayout.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { SavedLayoutNameError } from '@site/store/slices/layoutsSlice'
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
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

/** Create a site with root > container > text and a class on the text node. */
function seedSubtree() {
  const store = useEditorStore.getState()
  const site = store.createSite('Layouts Site')
  const rootId = site.pages[0].rootNodeId
  const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
  const textId = useEditorStore.getState().insertNode('base.text', { text: 'Saved copy' }, containerId)
  const cls = useEditorStore.getState().createClass('layout-style')
  useEditorStore.getState().addNodeClass(textId, cls.id)
  return { rootId, containerId, textId, classId: cls.id }
}

describe('layoutsSlice.saveNodeAsLayout', () => {
  it('captures the subtree and referenced classes into site.layouts', () => {
    const { containerId, textId, classId } = seedSubtree()

    const layoutId = useEditorStore.getState().saveNodeAsLayout(containerId, '  Hero section  ')
    expect(layoutId).not.toBeNull()

    const layouts = useEditorStore.getState().site!.layouts
    expect(layouts).toHaveLength(1)
    const layout = layouts[0]
    expect(layout.id).toBe(layoutId!)
    expect(layout.name).toBe('Hero section')
    expect(layout.rootNodeId).toBe(containerId)
    expect(Object.keys(layout.nodes).sort()).toEqual([containerId, textId].sort())
    expect(layout.nodes[textId].props.text).toBe('Saved copy')
    expect(layout.classes[classId]?.name).toBe('layout-style')

    // Dirty tracking: the new layout ships on the next incremental save.
    expect([...useEditorStore.getState()._dirtySave.layoutIds]).toContain(layoutId!)
  })

  it('refuses to capture the page root', () => {
    const { rootId } = seedSubtree()
    expect(useEditorStore.getState().saveNodeAsLayout(rootId, 'Whole body')).toBeNull()
    expect(useEditorStore.getState().site!.layouts).toHaveLength(0)
  })

  it('throws SavedLayoutNameError for empty and duplicate names', () => {
    const { containerId } = seedSubtree()
    expect(() => useEditorStore.getState().saveNodeAsLayout(containerId, '   ')).toThrow(SavedLayoutNameError)

    useEditorStore.getState().saveNodeAsLayout(containerId, 'Hero')
    expect(() => useEditorStore.getState().saveNodeAsLayout(containerId, 'Hero')).toThrow(SavedLayoutNameError)
    expect(useEditorStore.getState().site!.layouts).toHaveLength(1)
  })
})

describe('layoutsSlice.insertLayout', () => {
  it('restores the exact structure with fresh node ids', () => {
    const { rootId, containerId, textId, classId } = seedSubtree()
    const layoutId = useEditorStore.getState().saveNodeAsLayout(containerId, 'Hero')!

    // Remove the original so the insert is clearly a fresh materialisation.
    useEditorStore.getState().deleteNode(containerId)
    useEditorStore.getState().selectNode(rootId)

    const newRootId = useEditorStore.getState().insertLayout(layoutId)
    expect(newRootId).not.toBeNull()
    expect(newRootId).not.toBe(containerId)

    const page = useEditorStore.getState().site!.pages[0]
    expect(page.nodes[rootId].children).toContain(newRootId!)
    const newContainer = page.nodes[newRootId!]
    expect(newContainer.moduleId).toBe('base.container')
    expect(newContainer.children).toHaveLength(1)
    const newText = page.nodes[newContainer.children[0]]
    expect(newText.id).not.toBe(textId)
    expect(newText.moduleId).toBe('base.text')
    expect(newText.props.text).toBe('Saved copy')
    // Regular class is reused by id — same reference as the original.
    expect(newText.classIds).toEqual([classId])

    // The inserted root becomes the selection (same as preset inserts).
    expect(useEditorStore.getState().selectedNodeId).toBe(newRootId)
  })

  it('clones scoped classes with fresh ids and remapped scope.nodeId', () => {
    const { rootId, containerId, textId } = seedSubtree()
    const scoped = useEditorStore.getState().ensureNodeStyleClass(textId, 'Text')!
    const layoutId = useEditorStore.getState().saveNodeAsLayout(containerId, 'Scoped hero')!

    useEditorStore.getState().selectNode(rootId)
    const newRootId = useEditorStore.getState().insertLayout(layoutId)!

    const state = useEditorStore.getState()
    const page = state.site!.pages[0]
    const newText = page.nodes[page.nodes[newRootId].children[0]]
    const newScopedId = newText.classIds.find((id) => id !== scoped.id && state.site!.styleRules[id]?.scope?.type === 'node')
    expect(newScopedId).toBeDefined()
    const newScoped = state.site!.styleRules[newScopedId!]
    expect(newScoped.scope).toEqual({ type: 'node', nodeId: newText.id, role: 'module-style' })
    // The original scoped class still points at the original node.
    expect(state.site!.styleRules[scoped.id].scope).toEqual({ type: 'node', nodeId: textId, role: 'module-style' })
  })

  it('refuses to insert a second content outlet into the same document', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Outlet Site')
    const rootId = site.pages[0].rootNodeId
    const sectionId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const outletId = useEditorStore.getState().insertNode('base.outlet', {}, sectionId)
    expect(outletId).not.toBe('')

    const layoutId = useEditorStore.getState().saveNodeAsLayout(sectionId, 'Template shell')!
    useEditorStore.getState().selectNode(rootId)

    // The document still holds the original outlet — inserting the snapshot
    // would mint a second one.
    expect(useEditorStore.getState().insertLayout(layoutId)).toBeNull()

    // After deleting the original outlet the same layout inserts fine.
    useEditorStore.getState().deleteNode(sectionId)
    useEditorStore.getState().selectNode(rootId)
    expect(useEditorStore.getState().insertLayout(layoutId)).not.toBeNull()
  })

  it('strips snapshot refs to since-deleted Visual Components', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Ref Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const vcId = useEditorStore.getState().createVisualComponent('Badge')
    useEditorStore.getState().insertComponentRef(containerId, vcId)

    const layoutId = useEditorStore.getState().saveNodeAsLayout(containerId, 'With badge')!
    useEditorStore.getState().deleteVisualComponent(vcId)
    useEditorStore.getState().selectNode(rootId)

    const newRootId = useEditorStore.getState().insertLayout(layoutId)
    expect(newRootId).not.toBeNull()
    const page = useEditorStore.getState().site!.pages[0]
    const insertedModuleIds = page.nodes[newRootId!].children.map((id) => page.nodes[id]?.moduleId)
    expect(insertedModuleIds).not.toContain('base.visual-component-ref')
  })
})

describe('layoutsSlice.renameLayout / deleteLayout', () => {
  it('renames with validation and deletes by id', () => {
    const { containerId } = seedSubtree()
    const a = useEditorStore.getState().saveNodeAsLayout(containerId, 'Alpha')!
    const b = useEditorStore.getState().saveNodeAsLayout(containerId, 'Beta')!

    // Renaming to a name held by another layout is rejected.
    expect(() => useEditorStore.getState().renameLayout(b, 'Alpha')).toThrow(SavedLayoutNameError)
    // Renaming to its own (trimmed) name is a no-op, not an error.
    useEditorStore.getState().renameLayout(b, '  Beta ')
    useEditorStore.getState().renameLayout(b, 'Beta two')
    expect(useEditorStore.getState().site!.layouts.find((l) => l.id === b)?.name).toBe('Beta two')

    useEditorStore.getState().deleteLayout(a)
    expect(useEditorStore.getState().site!.layouts.map((l) => l.id)).toEqual([b])
  })
})
