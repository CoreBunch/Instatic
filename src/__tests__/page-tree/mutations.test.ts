import { describe, it, expect } from 'bun:test'
import { create } from 'mutative'
import type { Page } from '@core/page-tree'
import {
  createNode,
  insertNode,
  deleteNode,
  updateNodeProps,
  moveNode,
  duplicateNode,
  wrapNode,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
} from '@core/page-tree'
import { getParent, flattenSubtree } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(rootChildren: string[] = []): Page {
  const root = createNode('base.body')
  root.children = rootChildren
  return {
    id: 'page-1',
    slug: 'index',
    title: 'Home',
    nodes: { [root.id]: root },
    rootNodeId: root.id,
  }
}

function addChildToPage(page: Page, parentId: string, moduleId = 'base.div'): string {
  const node = createNode(moduleId)
  insertNode(page, node, parentId)
  return node.id
}

// ---------------------------------------------------------------------------
// createNode
// ---------------------------------------------------------------------------

describe('createNode', () => {
  it('creates a node with a unique id and the given moduleId', () => {
    const a = createNode('base.text')
    const b = createNode('base.text')
    expect(a.id).not.toBe(b.id)
    expect(a.moduleId).toBe('base.text')
  })
  it('copies defaults into props', () => {
    const n = createNode('base.text', { text: 'hello', size: 16 })
    expect(n.props).toEqual({ text: 'hello', size: 16 })
  })
  it('starts with empty children', () => {
    expect(createNode('base.div').children).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// insertNode
// ---------------------------------------------------------------------------

describe('insertNode', () => {
  it('appends to parent children by default', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const id1 = addChildToPage(page, rootId)
    const id2 = addChildToPage(page, rootId)
    expect(page.nodes[rootId].children).toEqual([id1, id2])
  })
  it('inserts at a specific index', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const id1 = addChildToPage(page, rootId)
    const id2 = addChildToPage(page, rootId)
    const middle = createNode('base.span')
    insertNode(page, middle, rootId, 1)
    expect(page.nodes[rootId].children).toEqual([id1, middle.id, id2])
  })
  it('throws if node with same id already exists', () => {
    const page = makePage()
    const node = createNode('base.div')
    insertNode(page, node, page.rootNodeId)
    expect(() => insertNode(page, node, page.rootNodeId)).toThrow()
  })
  it('throws if parent does not exist', () => {
    const page = makePage()
    const node = createNode('base.div')
    expect(() => insertNode(page, node, 'nonexistent')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

describe('deleteNode', () => {
  it('removes node and its descendants from the page', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const parentId = addChildToPage(page, rootId)
    const childId = addChildToPage(page, parentId)

    deleteNode(page, parentId)
    expect(page.nodes[parentId]).toBeUndefined()
    expect(page.nodes[childId]).toBeUndefined()
  })
  it('removes node from parent children array', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const id = addChildToPage(page, rootId)
    deleteNode(page, id)
    expect(page.nodes[rootId].children).not.toContain(id)
  })
  it('throws when trying to delete root', () => {
    const page = makePage()
    expect(() => deleteNode(page, page.rootNodeId)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// updateNodeProps
// ---------------------------------------------------------------------------

describe('updateNodeProps', () => {
  it('shallow-merges props', () => {
    const page = makePage()
    const id = addChildToPage(page, page.rootNodeId)
    page.nodes[id].props = { color: 'red', size: 16 }
    updateNodeProps(page, id, { size: 24 })
    expect(page.nodes[id].props).toEqual({ color: 'red', size: 24 })
  })
})

// ---------------------------------------------------------------------------
// moveNode
// ---------------------------------------------------------------------------

describe('moveNode', () => {
  it('moves a node to a new parent', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const aId = addChildToPage(page, rootId)   // container A
    const bId = addChildToPage(page, rootId)   // container B
    const childId = addChildToPage(page, aId)  // child of A

    moveNode(page, childId, bId, 0)
    expect(page.nodes[aId].children).not.toContain(childId)
    expect(page.nodes[bId].children).toContain(childId)
  })

  it('throws if trying to move root', () => {
    const page = makePage()
    const bId = addChildToPage(page, page.rootNodeId)
    expect(() => moveNode(page, page.rootNodeId, bId, 0)).toThrow()
  })

  it('throws if moving node into its own descendant', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const parentId = addChildToPage(page, rootId)
    const childId = addChildToPage(page, parentId)
    expect(() => moveNode(page, parentId, childId, 0)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// duplicateNode
// ---------------------------------------------------------------------------

describe('duplicateNode', () => {
  it('creates a copy with a new ID', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const id = addChildToPage(page, rootId)
    const newId = duplicateNode(page, id)
    expect(newId).not.toBe(id)
    expect(page.nodes[newId]).toBeDefined()
  })

  it('deep-clones subtree with new IDs', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const parentId = addChildToPage(page, rootId)
    const childId = addChildToPage(page, parentId)

    const newParentId = duplicateNode(page, parentId)
    expect(newParentId).not.toBe(parentId)
    const newChildren = page.nodes[newParentId].children
    expect(newChildren).toHaveLength(1)
    expect(newChildren[0]).not.toBe(childId) // new ID
  })

  it('inserts duplicate right after original in parent', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const id1 = addChildToPage(page, rootId)
    const id2 = addChildToPage(page, rootId)
    const newId = duplicateNode(page, id1)
    const children = page.nodes[rootId].children
    expect(children.indexOf(newId)).toBe(children.indexOf(id1) + 1)
    expect(children[children.length - 1]).toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// wrapNode
// ---------------------------------------------------------------------------

describe('wrapNode', () => {
  it('wraps a node in a new container', () => {
    const page = makePage()
    const rootId = page.rootNodeId
    const childId = addChildToPage(page, rootId)

    const wrapperId = wrapNode(page, childId, 'base.div')
    // Wrapper is now in root's children
    expect(page.nodes[rootId].children).toContain(wrapperId)
    // Original node is wrapper's child
    expect(page.nodes[wrapperId].children).toContain(childId)
    // Original is no longer a direct child of root
    expect(page.nodes[rootId].children).not.toContain(childId)
  })
})

// ---------------------------------------------------------------------------
// renameNode / toggleLocked / toggleHidden
// ---------------------------------------------------------------------------

describe('renameNode', () => {
  it('sets label on node', () => {
    const page = makePage()
    const id = addChildToPage(page, page.rootNodeId)
    renameNode(page, id, 'My Hero')
    expect(page.nodes[id].label).toBe('My Hero')
  })
  it('clears label on empty string', () => {
    const page = makePage()
    const id = addChildToPage(page, page.rootNodeId)
    renameNode(page, id, 'Label')
    renameNode(page, id, '')
    expect(page.nodes[id].label).toBeUndefined()
  })
})

describe('toggleNodeLocked', () => {
  it('toggles locked state', () => {
    const page = makePage()
    const id = addChildToPage(page, page.rootNodeId)
    expect(page.nodes[id].locked).toBeFalsy()
    toggleNodeLocked(page, id)
    expect(page.nodes[id].locked).toBe(true)
    toggleNodeLocked(page, id)
    expect(page.nodes[id].locked).toBe(false)
  })
})

describe('toggleNodeHidden', () => {
  it('toggles hidden state', () => {
    const page = makePage()
    const id = addChildToPage(page, page.rootNodeId)
    expect(page.nodes[id].hidden).toBeFalsy()
    toggleNodeHidden(page, id)
    expect(page.nodes[id].hidden).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mutative immutability
// ---------------------------------------------------------------------------

describe('Mutative immutability', () => {
  it('create() does not mutate the original when updating a node', () => {
    const page = makePage()
    const id = addChildToPage(page, page.rootNodeId)
    const original = page.nodes[id].props

    const nextPage = create(page, (draft) => {
      updateNodeProps(draft, id, { color: 'blue' })
    })

    // Original unchanged
    expect(page.nodes[id].props).toBe(original)
    // New page has updated props
    expect(nextPage.nodes[id].props).toEqual({ color: 'blue' })
  })
})
