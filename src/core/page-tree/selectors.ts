import type { BaseNode } from './baseNode'
import type { NodeTree } from './treeSchema'
import type { PageNode } from './pageNode'

/**
 * Pure selector functions for the page tree.
 * No side effects — safe to call in Zustand selectors, unit tests, and React renders.
 *
 * All functions accept a generic `NodeTree<TNode>` so they work with both
 * page trees (NodeTree<PageNode>) and VC trees (NodeTree<VCNode>).
 * Callers that pass a `Page` (which IS a NodeTree<PageNode>) continue to work
 * unchanged thanks to TypeScript's structural typing.
 */

// ---------------------------------------------------------------------------
// Node access
// ---------------------------------------------------------------------------

/** Get a node by ID — O(1). Returns undefined if not found. */
export function getNode<TNode extends BaseNode>(tree: NodeTree<TNode>, id: string): TNode | undefined {
  return tree.nodes[id]
}

/** Get a node by ID, throwing if not found. */
export function getNodeOrThrow<TNode extends BaseNode>(tree: NodeTree<TNode>, id: string): TNode {
  const node = tree.nodes[id]
  if (!node) throw new Error(`[PageTree] Node "${id}" not found`)
  return node
}

/** Get all direct children of a node as TNode objects. */
export function getChildren<TNode extends BaseNode>(tree: NodeTree<TNode>, nodeId: string): TNode[] {
  const node = tree.nodes[nodeId]
  if (!node) return []
  return node.children
    .map((id) => tree.nodes[id])
    .filter((n): n is TNode => n !== undefined)
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Find the parent of a node — O(1) via the denormalised `parentId` pointer.
 *
 * `parentId` is a derived cache of the `children` arrays, maintained by every
 * tree mutation and (re)stamped by `reindexNodeParents` at every load/parse/
 * compose boundary. It is `null` for the root node (and for detached nodes), so
 * this returns `undefined` for them. It deliberately does NOT scan
 * `tree.nodes` — that O(N) scan was the single highest-cost engine hot path
 * (called per pointer-move during drag, and in O(M·D) mutation loops).
 */
export function getParent<TNode extends BaseNode>(tree: NodeTree<TNode>, nodeId: string): TNode | undefined {
  const node = tree.nodes[nodeId]
  if (!node || !node.parentId) return undefined
  return tree.nodes[node.parentId]
}

/** Get ordered ancestor chain from root down to (but not including) nodeId. */
export function getAncestors<TNode extends BaseNode>(tree: NodeTree<TNode>, nodeId: string): TNode[] {
  const ancestors: TNode[] = []
  let current = nodeId
  const visited = new Set<string>()

  while (true) {
    if (visited.has(current)) break // cycle guard
    visited.add(current)
    const parent = getParent(tree, current)
    if (!parent) break
    ancestors.unshift(parent)
    current = parent.id
  }
  return ancestors
}

/**
 * Collect a node + all its descendants in depth-first pre-order, operating on a
 * raw flat node Record.
 *
 * This is THE single descendant-collection primitive for the whole engine —
 * every deletion / duplication path that needs "this node and everything under
 * it" routes through here (or through `flattenSubtree`, its NodeTree-typed
 * sibling). The `visited` Set is a hard cycle guard: a corrupt tree whose
 * `children` arrays form a cycle terminates here instead of looping forever.
 * No caller may re-implement this walk without that guard.
 *
 * Returns IDs in pre-order (root first, then each subtree left-to-right) — the
 * order the DOM tree panel relies on for virtual-scroll flattening.
 */
export function collectSubtreeIds(nodes: Record<string, BaseNode>, rootId: string): string[] {
  const result: string[] = []
  const stack: string[] = [rootId]
  const visited = new Set<string>()

  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue // cycle guard
    visited.add(id)
    const node = nodes[id]
    if (!node) continue
    result.push(id)
    // Push children in reverse so leftmost child is processed first (stack is LIFO)
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i])
    }
  }
  return result
}

/**
 * Return all node IDs in depth-first pre-order starting at nodeId.
 * Useful for virtual-scroll flattening in the DOM tree panel.
 *
 * Thin NodeTree-typed wrapper over `collectSubtreeIds` — same cycle-safe walk.
 */
export function flattenSubtree<TNode extends BaseNode>(tree: NodeTree<TNode>, nodeId: string): string[] {
  return collectSubtreeIds(tree.nodes, nodeId)
}

/**
 * Check whether ancestorId is an ancestor of nodeId.
 * Used to prevent illegal moves in drag-to-reorder (cannot drop a node inside itself).
 */
export function isAncestor<TNode extends BaseNode>(tree: NodeTree<TNode>, ancestorId: string, nodeId: string): boolean {
  if (ancestorId === nodeId) return true
  let current = nodeId
  const visited = new Set<string>()
  while (true) {
    if (visited.has(current)) return false
    visited.add(current)
    const parent = getParent(tree, current)
    if (!parent) return false
    if (parent.id === ancestorId) return true
    current = parent.id
  }
}

// ---------------------------------------------------------------------------
// Props resolution
// ---------------------------------------------------------------------------

/**
 * Resolve props for a node at a given breakpoint.
 *
 * Breakpoint overrides shallow-merge on top of base props, but ONLY for keys
 * the module schema marks `breakpointOverridable: true`. Module props are
 * content (single value across all breakpoints) by default — the published
 * page is one HTML document, so text/tag/src/etc. cannot meaningfully differ
 * per viewport. Visual responsive variation lives in class breakpoint styles,
 * not in module props.
 *
 * Pass `schema` from `ModuleDefinition.schema` so legacy or hand-crafted
 * override entries for non-responsive keys are ignored at read time. If
 * `schema` is omitted (e.g. unknown module, low-level tree tooling), every
 * override key applies — same shape as the raw map. Returns base props
 * unchanged if no `breakpointId` is provided.
 */
export function resolveProps(
  node: PageNode,
  breakpointId?: string,
  schema?: PropertySchema,
): Record<string, unknown> {
  const base = node.moduleOverlay?.props ?? node.props
  if (!breakpointId) return base
  const override = node.breakpointOverrides[breakpointId]
  if (!override || Object.keys(override).length === 0) return base
  if (!schema) return { ...base, ...override }
  // Filter out keys the module schema does NOT mark breakpointOverridable.
  // Anything else is content; it must not vary per breakpoint at read time
  // even if the persisted data carries a value (legacy / agent / fixture).
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(override)) {
    if (schema[key]?.breakpointOverridable === true) {
      filtered[key] = value
    }
  }
  if (Object.keys(filtered).length === 0) return base
  return { ...base, ...filtered }
}

// ---------------------------------------------------------------------------
// Property condition evaluation
// ---------------------------------------------------------------------------

import type { PropertyCondition, PropertySchema } from '@core/module-engine-schema'

/**
 * Evaluate a declarative PropertyCondition against a props object.
 * Used by the Properties Panel to show/hide controls.
 * Constraint #212: conditions are declarative objects, never functions.
 */
export function evaluateCondition(
  condition: PropertyCondition,
  props: Record<string, unknown>
): boolean {
  if ('and' in condition) {
    return condition.and.every((c) => evaluateCondition(c, props))
  }
  if ('or' in condition) {
    return condition.or.some((c) => evaluateCondition(c, props))
  }
  if ('eq' in condition) {
    return props[condition.field] === condition.eq
  }
  if ('notEq' in condition) {
    return props[condition.field] !== condition.notEq
  }
  if ('in' in condition) {
    return condition.in.includes(props[condition.field])
  }
  if ('notIn' in condition) {
    return !condition.notIn.includes(props[condition.field])
  }
  return true
}
