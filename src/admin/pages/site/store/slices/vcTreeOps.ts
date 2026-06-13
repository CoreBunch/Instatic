/**
 * vcTreeOps — pure helpers and typed domain errors for the Visual Components
 * data layer. Split out of `visualComponentsSlice.ts` (which owns the store
 * actions) so the page-tree surgery — VC-ref collection, cascade removal,
 * subtree cloning for componentization — lives in one focused module, the
 * same pattern as `vcSlotReconcile.ts`.
 */

import { nanoid } from 'nanoid'
import type { VCNode } from '@core/visualComponents'
import type { BaseNode, PageNode, StyleRule } from '@core/page-tree'
import { removeNodeSubtrees } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Custom error types (exported so UI + tests can catch by class)
// ---------------------------------------------------------------------------

export class VisualComponentNameError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentNameError'
    this.code = code
  }
}

export class VisualComponentParamNameError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentParamNameError'
    this.code = code
  }
}

export class VisualComponentRecursionError extends Error {
  constructor(message: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentRecursionError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect all VC componentIds referenced by base.visual-component-ref nodes
 * in the page's flat-map subtree rooted at rootNodeId.
 */
export function collectVCRefsFromPageSubtree(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
): Set<string> {
  const refs = new Set<string>()
  const stack: string[] = [rootNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = pageNodes[id]
    if (!node) continue
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = node.props.componentId
      if (typeof componentId === 'string' && componentId.length > 0) {
        refs.add(componentId)
      }
    }
    stack.push(...node.children)
  }
  return refs
}

/**
 * Collect all node IDs in the page flat-map subtree rooted at rootNodeId (DFS).
 */
export function collectSubtreeNodeIds(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
): string[] {
  const ids: string[] = []
  const stack: string[] = [rootNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = pageNodes[id]
    if (!node) continue
    ids.push(id)
    stack.push(...node.children)
  }
  return ids
}

/**
 * Remove all `base.visual-component-ref` nodes referencing `vcId` from the
 * given flat-map node tree, along with their entire subtrees (slot-instances,
 * user content, etc.). Operates inside an Immer producer — mutates in place.
 *
 * Used by `deleteVisualComponent` to cascade ref removal across every page and
 * every remaining VC tree in one atomic `mutateSite` call.
 */
export function cascadeRemoveVCRefs(
  nodes: Record<string, BaseNode>,
  vcId: string,
): void {
  // Collect all top-level ref IDs that point at vcId
  const refNodeIds: string[] = []
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (
      node.moduleId === 'base.visual-component-ref' &&
      node.props.componentId === vcId
    ) {
      refNodeIds.push(nodeId)
    }
  }

  // Cascade-remove each ref node and its entire subtree (slot-instances, user
  // content, etc.) — same tree surgery the loader uses for dangling refs.
  removeNodeSubtrees(nodes, refNodeIds)
}

/**
 * Clone a page's flat-map subtree into a flat VCNode map.
 *
 * - Allocates a fresh nanoid() for every cloned node.
 * - Populates idMap (oldId → newId) for each visited node so that
 *   parent `children` string arrays reference the correct new IDs.
 * - For node-scoped classes (scope.type === 'node' && scope.nodeId === oldId):
 *   rewrites scope.nodeId to the new ID in-place (must run inside an Immer
 *   producer) and records the classId in hoistedClassIds so the caller can
 *   attach it to the new VC's top-level classIds array.
 * - dynamicBindings is intentionally NOT copied — VCNode has no dynamicBindings.
 *
 * Returns { nodes, rootNodeId } — a flat NodeTree for VisualComponent.tree.
 */
export function clonePageSubtreeToFlatNodes(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
  siteClasses: Record<string, StyleRule>,
  idMap: Map<string, string>,
  hoistedClassIds: Set<string>,
): { nodes: Record<string, VCNode>; rootNodeId: string } {
  const nodes: Record<string, VCNode> = {}

  // Step 1: allocate new IDs for every node in the subtree (DFS)
  function allocateIds(nodeId: string): void {
    if (idMap.has(nodeId)) return // already allocated (cycle guard)
    idMap.set(nodeId, nanoid())
    const pageNode = pageNodes[nodeId]
    if (!pageNode) return
    for (const childId of pageNode.children) allocateIds(childId)
  }
  allocateIds(rootNodeId)

  // Step 2: clone each node using the id map
  const visited = new Set<string>()
  function cloneNode(oldNodeId: string): void {
    if (visited.has(oldNodeId)) return
    visited.add(oldNodeId)

    const pageNode = pageNodes[oldNodeId]
    if (!pageNode) {
      throw new Error(`convertNodeToComponent: page node "${oldNodeId}" not found during clone`)
    }

    const newId = idMap.get(oldNodeId)!

    // Process classIds: rewrite node-scoped ones to the new ID and hoist to VC level
    const clonedClassIds: string[] = []
    for (const classId of pageNode.classIds) {
      const cls = siteClasses[classId]
      if (cls && cls.scope?.type === 'node' && cls.scope.nodeId === oldNodeId) {
        // Rewrite scope in-place (Immer draft mutation)
        cls.scope.nodeId = newId
        hoistedClassIds.add(classId)
      }
      clonedClassIds.push(classId)
    }

    const vcNode: VCNode = {
      id: newId,
      moduleId: pageNode.moduleId,
      props: { ...pageNode.props },
      breakpointOverrides: Object.fromEntries(
        Object.entries(pageNode.breakpointOverrides).map(([k, v]) => [k, { ...v }]),
      ),
      // children[] references the NEW ids of direct children
      children: pageNode.children.map((childId) => idMap.get(childId)!),
      classIds: clonedClassIds,
    }

    // Carry optional fields (dynamicBindings excluded — VCNode has no dynamicBindings field)
    if (pageNode.label !== undefined) vcNode.label = pageNode.label
    if (pageNode.locked !== undefined) vcNode.locked = pageNode.locked
    if (pageNode.hidden !== undefined) vcNode.hidden = pageNode.hidden
    if (pageNode.propBindings !== undefined) {
      vcNode.propBindings = Object.fromEntries(
        Object.entries(pageNode.propBindings).map(([k, v]) => [k, { ...v }]),
      )
    }

    nodes[newId] = vcNode

    // Recurse into children
    for (const childId of pageNode.children) cloneNode(childId)
  }
  cloneNode(rootNodeId)

  return { nodes, rootNodeId: idMap.get(rootNodeId)! }
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------
