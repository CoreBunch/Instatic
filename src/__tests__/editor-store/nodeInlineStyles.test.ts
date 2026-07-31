/**
 * Editor-store tests for the per-node inline-style actions
 * (`setNodeInlineStyles` / `removeNodeInlineStyleProperty`) — the "Style inline"
 * editing layer that writes to `node.inlineStyles`.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import '@modules/base/index'

function freshStore() {
  useEditorStore.getState().clearSite()
  useEditorStore.setState({
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    clipboardEntry: null,
    activeClassId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

function setup(): string {
  const site = useEditorStore.getState().createSite('Inline Site')
  const rootId = site.pages[0].rootNodeId
  return useEditorStore.getState().insertNode('base.container', {}, rootId)
}

function nodeInline(nodeId: string): Record<string, unknown> | undefined {
  return useEditorStore.getState().site!.pages[0].nodes[nodeId]!.inlineStyles
}

describe('setNodeInlineStyles', () => {
  it('sets inline style properties on the node', () => {
    const id = setup()
    useEditorStore.getState().setNodeInlineStyles(id, { backgroundImage: `url('/uploads/x.png')`, color: 'red' })
    expect(nodeInline(id)).toEqual({ backgroundImage: `url('/uploads/x.png')`, color: 'red' })
  })

  it('merges patches and removes a property when value is null', () => {
    const id = setup()
    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red', display: 'flex' })
    useEditorStore.getState().setNodeInlineStyles(id, { color: null })
    expect(nodeInline(id)).toEqual({ display: 'flex' })
  })

  it('drops the inlineStyles field entirely once the last property is removed', () => {
    const id = setup()
    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })
    useEditorStore.getState().removeNodeInlineStyleProperty(id, 'color')
    expect(nodeInline(id)).toBeUndefined()
  })

  it('is undoable as a single history step', () => {
    const id = setup()
    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red' })
    expect(nodeInline(id)).toEqual({ color: 'red' })
    useEditorStore.getState().undo()
    expect(nodeInline(id)).toBeUndefined()
  })

  it('clearNodeInlineStyles removes the whole inlineStyles field in one step', () => {
    const id = setup()
    useEditorStore.getState().setNodeInlineStyles(id, { color: 'red', display: 'flex' })

    useEditorStore.getState().clearNodeInlineStyles(id)
    expect(nodeInline(id)).toBeUndefined()
    // ONE undo restores the full style bag — the clear was a single step.
    useEditorStore.getState().undo()
    expect(nodeInline(id)).toEqual({ color: 'red', display: 'flex' })
  })

  it('clearNodeInlineStyles is a no-op (no history) when there are no inline styles', () => {
    const id = setup()
    useEditorStore.getState().clearNodeInlineStyles(id)
    // No entry was pushed: the next undo reverts the node INSERT itself.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[id]).toBeUndefined()
  })

  it('a no-op patch (removing an absent key) records no change', () => {
    const id = setup()
    useEditorStore.getState().removeNodeInlineStyleProperty(id, 'color')
    // No entry was pushed: the next undo reverts the node INSERT itself.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[id]).toBeUndefined()
  })

  it('setInlineStyleEditing(true) clears the active class (mutually exclusive)', () => {
    const site = useEditorStore.getState().createSite('S')
    const rootId = site.pages[0].rootNodeId
    const id = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const cls = useEditorStore.getState().createClass('card')
    useEditorStore.getState().addNodeClass(id, cls.id)
    useEditorStore.getState().setActiveClass(cls.id)
    expect(useEditorStore.getState().activeClassId).toBe(cls.id)

    useEditorStore.getState().setInlineStyleEditing(true)
    expect(useEditorStore.getState().inlineStyleEditing).toBe(true)
    expect(useEditorStore.getState().activeClassId).toBeNull()

    // Selecting a class switches back off inline editing.
    useEditorStore.getState().setActiveClass(cls.id)
    expect(useEditorStore.getState().inlineStyleEditing).toBe(false)
    expect(useEditorStore.getState().activeClassId).toBe(cls.id)
  })

  it('selecting an inline-only node opens inline editing automatically', () => {
    const site = useEditorStore.getState().createSite('S')
    const rootId = site.pages[0].rootNodeId
    const id = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().setNodeInlineStyles(id, { backgroundImage: `url('/uploads/x.png')` })

    // Deselect, then select the inline-only node → inline editing is seeded on.
    useEditorStore.getState().selectNode(null)
    useEditorStore.getState().selectNode(id)
    expect(useEditorStore.getState().inlineStyleEditing).toBe(true)
    expect(useEditorStore.getState().activeClassId).toBeNull()
  })

  it('clears display + flex deps in a single patch (orphan-prune scenario)', () => {
    const id = setup()
    // Simulate "display: flex" then setting a flex sub-property.
    useEditorStore.getState().setNodeInlineStyles(id, { display: 'flex', alignItems: 'center' })

    // Clearing display must prune the now-orphaned flex property too — one step.
    useEditorStore.getState().setNodeInlineStyles(id, {
      display: null,
      alignItems: null,
      justifyContent: null,
      gap: null,
    })

    expect(nodeInline(id)).toBeUndefined()
    // ONE undo restores both pruned properties — the clear was a single step.
    useEditorStore.getState().undo()
    expect(nodeInline(id)).toEqual({ display: 'flex', alignItems: 'center' })
  })
})
