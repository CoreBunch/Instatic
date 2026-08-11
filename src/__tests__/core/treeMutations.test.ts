/**
 * Unit tests for page-tree mutations operating on a bare NodeTree.
 *
 * These tests validate that every mutation function works correctly with a
 * generic NodeTree<PageNode> — no Page wrapper, no Site, no store.
 *
 * Each test builds the minimal input tree as `{ nodes: {...}, rootNodeId }`,
 * calls the mutation, and asserts the resulting tree state.
 */
import { describe, it, expect } from 'bun:test'
import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import {
  createNode,
  insertNode,
  deleteNode,
  moveNode,
  duplicateNode,
  wrapNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  reindexNodeParents,
} from '@core/page-tree'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  moduleId = 'base.div',
  children: string[] = [],
): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
  }
}

function makeTree(
  nodes: Record<string, PageNode>,
  rootNodeId = 'root',
): NodeTree<PageNode> {
  // Derive the parentId index — mirrors what parse/loadSite do for real trees.
  reindexNodeParents(nodes)
  return { nodes, rootNodeId }
}

/** Minimal tree: just a root node. */
function freshTree(): NodeTree<PageNode> {
  return makeTree({ root: makeNode('root', 'base.body') })
}

// ---------------------------------------------------------------------------
// insertNode
// ---------------------------------------------------------------------------

describe('insertNode into NodeTree', () => {
  it('appends to parent children by default', () => {
    const tree = freshTree()
    const node = createNode('base.div')
    insertNode(tree, node, 'root')
    expect(tree.nodes['root'].children).toContain(node.id)
  })

  it('inserts at index 0 (prepend)', () => {
    const tree = freshTree()
    const a = createNode('base.div')
    const b = createNode('base.div')
    insertNode(tree, a, 'root')
    insertNode(tree, b, 'root', 0)
    expect(tree.nodes['root'].children[0]).toBe(b.id)
    expect(tree.nodes['root'].children[1]).toBe(a.id)
  })

  it('inserts at middle index', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a', 'c']),
      a: makeNode('a'),
      c: makeNode('c'),
    })
    const b = makeNode('b')
    insertNode(tree, b, 'root', 1)
    expect(tree.nodes['root'].children).toEqual(['a', 'b', 'c'])
  })

  it('appends when index exceeds children length', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    const b = makeNode('b')
    insertNode(tree, b, 'root', 99)
    expect(tree.nodes['root'].children).toEqual(['a', 'b'])
  })

  it('registers node in tree.nodes', () => {
    const tree = freshTree()
    const node = createNode('base.text', { text: 'hello' })
    insertNode(tree, node, 'root')
    expect(tree.nodes[node.id]).toBeDefined()
    expect(tree.nodes[node.id].moduleId).toBe('base.text')
  })

  it('throws if node with same id already exists', () => {
    const tree = freshTree()
    const node = createNode('base.div')
    insertNode(tree, node, 'root')
    expect(() => insertNode(tree, node, 'root')).toThrow()
  })

  it('throws if parent does not exist', () => {
    const tree = freshTree()
    const node = makeNode('x')
    expect(() => insertNode(tree, node, 'nonexistent')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

describe('deleteNode from NodeTree', () => {
  it('removes the node from tree.nodes', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    deleteNode(tree, 'a')
    expect(tree.nodes['a']).toBeUndefined()
  })

  it('removes node id from parent children array', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a', 'b']),
      a: makeNode('a'),
      b: makeNode('b'),
    })
    deleteNode(tree, 'a')
    expect(tree.nodes['root'].children).not.toContain('a')
    expect(tree.nodes['root'].children).toContain('b')
  })

  it('cascades through direct children', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['parent']),
      parent: makeNode('parent', 'base.div', ['child1', 'child2']),
      child1: makeNode('child1'),
      child2: makeNode('child2'),
    })
    deleteNode(tree, 'parent')
    expect(tree.nodes['parent']).toBeUndefined()
    expect(tree.nodes['child1']).toBeUndefined()
    expect(tree.nodes['child2']).toBeUndefined()
  })

  it('cascades through grandchildren', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a', 'base.div', ['b']),
      b: makeNode('b', 'base.div', ['c']),
      c: makeNode('c'),
    })
    deleteNode(tree, 'a')
    expect(tree.nodes['a']).toBeUndefined()
    expect(tree.nodes['b']).toBeUndefined()
    expect(tree.nodes['c']).toBeUndefined()
    expect(tree.nodes['root'].children).toEqual([])
  })

  it('cannot delete root', () => {
    const tree = freshTree()
    expect(() => deleteNode(tree, 'root')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// moveNode
// ---------------------------------------------------------------------------

describe('moveNode within NodeTree', () => {
  it('moves a node to a new parent', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a', 'b']),
      a: makeNode('a', 'base.div', ['child']),
      b: makeNode('b'),
      child: makeNode('child'),
    })
    moveNode(tree, 'child', 'b', 0)
    expect(tree.nodes['a'].children).not.toContain('child')
    expect(tree.nodes['b'].children).toContain('child')
  })

  it('reorders within the same parent', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a', 'b', 'c']),
      a: makeNode('a'),
      b: makeNode('b'),
      c: makeNode('c'),
    })
    moveNode(tree, 'a', 'root', 2)
    expect(tree.nodes['root'].children).toEqual(['b', 'c', 'a'])
  })

  it('cannot move root', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    expect(() => moveNode(tree, 'root', 'a', 0)).toThrow()
  })

  it('prevents cycle: cannot move ancestor under its own descendant', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['parent']),
      parent: makeNode('parent', 'base.div', ['child']),
      child: makeNode('child'),
    })
    expect(() => moveNode(tree, 'parent', 'child', 0)).toThrow()
  })

  it('rejects a missing source without mutating a valid target parent', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['target']),
      target: makeNode('target', 'base.div', ['existing']),
      existing: makeNode('existing'),
    })
    const before = JSON.stringify(tree)

    expect(() => moveNode(tree, 'missing', 'target', 0)).toThrow(
      '[PageTree] Node "missing" not found',
    )
    expect(JSON.stringify(tree)).toBe(before)
  })

  it('rejects a missing target without detaching the source', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['source']),
      source: makeNode('source'),
    })
    const before = JSON.stringify(tree)

    expect(() => moveNode(tree, 'source', 'missing', 0)).toThrow(
      '[PageTree] New parent "missing" not found',
    )
    expect(JSON.stringify(tree)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// duplicateNode
// ---------------------------------------------------------------------------

describe('duplicateNode within NodeTree', () => {
  it('produces a clone with a fresh id', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a', 'base.text'),
    })
    const newId = duplicateNode(tree, 'a')
    expect(newId).not.toBe('a')
    expect(tree.nodes[newId]).toBeDefined()
    expect(tree.nodes[newId].moduleId).toBe('base.text')
  })

  it('deep-clones subtree with all-new ids', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['parent']),
      parent: makeNode('parent', 'base.div', ['child']),
      child: makeNode('child', 'base.text'),
    })
    const newParentId = duplicateNode(tree, 'parent')
    expect(newParentId).not.toBe('parent')
    const clonedChildren = tree.nodes[newParentId].children
    expect(clonedChildren).toHaveLength(1)
    // The child clone has a new id — not 'child'
    expect(clonedChildren[0]).not.toBe('child')
    expect(tree.nodes[clonedChildren[0]]).toBeDefined()
    expect(tree.nodes[clonedChildren[0]].moduleId).toBe('base.text')
  })

  it('inserts clone immediately after the original in the parent', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a', 'b']),
      a: makeNode('a'),
      b: makeNode('b'),
    })
    const newId = duplicateNode(tree, 'a')
    const children = tree.nodes['root'].children
    expect(children.indexOf(newId)).toBe(children.indexOf('a') + 1)
    // 'b' must stay at the end
    expect(children[children.length - 1]).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// wrapNode
// ---------------------------------------------------------------------------

describe('wrapNode within NodeTree', () => {
  it('wraps the target in a new container', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    const wrapperId = wrapNode(tree, 'a', 'base.div')
    expect(tree.nodes['root'].children).toContain(wrapperId)
    expect(tree.nodes['root'].children).not.toContain('a')
    expect(tree.nodes[wrapperId].children).toContain('a')
  })

  it('preserves the node original position among siblings', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a', 'b', 'c']),
      a: makeNode('a'),
      b: makeNode('b'),
      c: makeNode('c'),
    })
    const wrapperId = wrapNode(tree, 'b', 'base.div')
    expect(tree.nodes['root'].children).toEqual(['a', wrapperId, 'c'])
    expect(tree.nodes[wrapperId].children).toContain('b')
  })

  it('cannot wrap root', () => {
    const tree = freshTree()
    expect(() => wrapNode(tree, 'root', 'base.div')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// updateNodeProps
// ---------------------------------------------------------------------------

describe('updateNodeProps on NodeTree', () => {
  it('shallow-merges props patch', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    tree.nodes['a'].props = { color: 'red', size: 16 }
    updateNodeProps(tree, 'a', { size: 24 })
    expect(tree.nodes['a'].props).toEqual({ color: 'red', size: 24 })
  })

  it('adds new props without removing existing ones', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    tree.nodes['a'].props = { existing: true }
    updateNodeProps(tree, 'a', { newProp: 'hello' })
    expect(tree.nodes['a'].props['existing']).toBe(true)
    expect(tree.nodes['a'].props['newProp']).toBe('hello')
  })

  it('throws for unknown nodeId', () => {
    const tree = freshTree()
    expect(() => updateNodeProps(tree, 'nonexistent', { color: 'blue' })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// setBreakpointOverride / clearBreakpointOverride
// ---------------------------------------------------------------------------

describe('setBreakpointOverride on NodeTree', () => {
  it('stores override under breakpoint key', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    setBreakpointOverride(tree, 'a', 'mobile', { fontSize: 14 })
    expect(tree.nodes['a'].breakpointOverrides['mobile']).toEqual({ fontSize: 14 })
  })

  it('merges with existing overrides for the same breakpoint', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    setBreakpointOverride(tree, 'a', 'mobile', { fontSize: 14 })
    setBreakpointOverride(tree, 'a', 'mobile', { color: 'white' })
    expect(tree.nodes['a'].breakpointOverrides['mobile']).toEqual({ fontSize: 14, color: 'white' })
  })

  it('stores different breakpoints separately', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    setBreakpointOverride(tree, 'a', 'mobile', { fontSize: 14 })
    setBreakpointOverride(tree, 'a', 'tablet', { fontSize: 20 })
    expect(tree.nodes['a'].breakpointOverrides['mobile']).toEqual({ fontSize: 14 })
    expect(tree.nodes['a'].breakpointOverrides['tablet']).toEqual({ fontSize: 20 })
  })
})

describe('clearBreakpointOverride on NodeTree', () => {
  it('deletes the breakpoint override', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    setBreakpointOverride(tree, 'a', 'mobile', { fontSize: 14 })
    clearBreakpointOverride(tree, 'a', 'mobile')
    expect(tree.nodes['a'].breakpointOverrides['mobile']).toBeUndefined()
  })

  it('does not affect overrides for other breakpoints', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    setBreakpointOverride(tree, 'a', 'mobile', { fontSize: 14 })
    setBreakpointOverride(tree, 'a', 'tablet', { fontSize: 20 })
    clearBreakpointOverride(tree, 'a', 'mobile')
    expect(tree.nodes['a'].breakpointOverrides['tablet']).toEqual({ fontSize: 20 })
  })

  it('is a no-op for a breakpoint with no overrides', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    expect(() => clearBreakpointOverride(tree, 'a', 'nonexistent')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// renameNode
// ---------------------------------------------------------------------------

describe('renameNode on NodeTree', () => {
  it('sets the label field', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    renameNode(tree, 'a', 'My Hero')
    expect(tree.nodes['a'].label).toBe('My Hero')
  })

  it('clears label for empty string', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    renameNode(tree, 'a', 'Label')
    renameNode(tree, 'a', '')
    expect(tree.nodes['a'].label).toBeUndefined()
  })

  it('trims whitespace', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    renameNode(tree, 'a', '  trimmed  ')
    expect(tree.nodes['a'].label).toBe('trimmed')
  })
})

// ---------------------------------------------------------------------------
// toggleNodeLocked
// ---------------------------------------------------------------------------

describe('toggleNodeLocked on NodeTree', () => {
  it('sets locked to true on first call', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    expect(tree.nodes['a'].locked).toBeFalsy()
    toggleNodeLocked(tree, 'a')
    expect(tree.nodes['a'].locked).toBe(true)
  })

  it('flips back to false on second call', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    toggleNodeLocked(tree, 'a')
    toggleNodeLocked(tree, 'a')
    expect(tree.nodes['a'].locked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// toggleNodeHidden
// ---------------------------------------------------------------------------

describe('toggleNodeHidden on NodeTree', () => {
  it('sets hidden to true on first call', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    expect(tree.nodes['a'].hidden).toBeFalsy()
    toggleNodeHidden(tree, 'a')
    expect(tree.nodes['a'].hidden).toBe(true)
  })

  it('flips back to false on second call', () => {
    const tree = makeTree({
      root: makeNode('root', 'base.body', ['a']),
      a: makeNode('a'),
    })
    toggleNodeHidden(tree, 'a')
    toggleNodeHidden(tree, 'a')
    expect(tree.nodes['a'].hidden).toBe(false)
  })
})
