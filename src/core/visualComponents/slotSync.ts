/**
 * slotSync — sync slot-instance children of a VC ref with its VC's slot params.
 *
 * Architecture source: Task 4 of the Tree Unification Refactor.
 *
 * A VC ref on a page must have exactly one `base.slot-instance` child per slot
 * param declared by its referenced VC, in param order. This module provides:
 *
 *   syncSlotInstances — pure function that computes the ops needed to bring
 *     a VC ref's children into alignment with its VC's slot params.
 *
 *   applySlotSyncResult — helper that applies a SyncResult to a mutable
 *     nodes map (called inside Mutative producers in siteSlice / visualComponentsSlice).
 *
 * Constraint #269: This file must NOT import from editor/ or editor-store/.
 */

import { nanoid } from 'nanoid'
import { deleteSubtree, type BaseNode } from '@core/page-tree'
import type { VisualComponent } from './schemas'

// ---------------------------------------------------------------------------
// collectSlotOutletNames — pure helper
// ---------------------------------------------------------------------------

/**
 * Walk the VC's flat node tree and collect every slotName declared by a
 * `base.slot-outlet` node, in DFS pre-order, deduplicated by name (first
 * appearance wins).
 *
 * The slot-outlet IS the slot — no separate `vc.params` slot entry required.
 * The VC author drops a slot-outlet wherever they want consumer content to go,
 * sets its slotName, and that's the entire authoring step. Multiple
 * slot-outlets with the same slotName render the same slot's content at
 * multiple positions and count as ONE slot for the consumer's slot-instance.
 *
 * Returns an empty array when the VC has no slot-outlets.
 */
export function collectSlotOutletNames(tree: {
  rootNodeId: string
  nodes: Record<string, BaseNode>
}): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const stack: string[] = [tree.rootNodeId]

  while (stack.length > 0) {
    const id = stack.pop()!
    const node = tree.nodes[id]
    if (!node) continue

    if (node.moduleId === 'base.slot-outlet') {
      const slotName =
        typeof node.props.slotName === 'string' && node.props.slotName
          ? node.props.slotName
          : 'children'
      if (!seen.has(slotName)) {
        seen.add(slotName)
        result.push(slotName)
      }
    }

    // DFS pre-order: push children in reverse so leftmost is processed first.
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i])
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Op types
// ---------------------------------------------------------------------------

/** Insert a new locked slot-instance node as a child of the VC ref. */
interface InsertSlotOp {
  kind: 'insert'
  /** Generated ID for the new slot-instance node. */
  slotInstanceId: string
  /** The slotName prop value for the new slot-instance. */
  slotName: string
}

/** Update the slotName prop on an existing slot-instance (rename case). */
interface RenameSlotOp {
  kind: 'rename'
  /** ID of the existing slot-instance node. */
  nodeId: string
  /** New slot name to set on the node's props.slotName. */
  newSlotName: string
}

/** Delete an existing slot-instance node and its entire subtree. */
interface DeleteSlotOp {
  kind: 'delete'
  /** ID of the slot-instance (or non-slot-instance child) to delete. */
  nodeId: string
}

type SyncOp = InsertSlotOp | RenameSlotOp | DeleteSlotOp

// ---------------------------------------------------------------------------
// SyncResult
// ---------------------------------------------------------------------------

interface SyncResult {
  /**
   * Operations to apply:
   *   - insert: add a new slot-instance (node is in newNodes)
   *   - rename: update props.slotName on an existing slot-instance
   *   - delete: remove the slot-instance and its entire subtree
   *
   * After applying all ops, also set vcRefNode.children = orderedChildIds.
   */
  ops: SyncOp[]
  /**
   * New BaseNode entries (for insert ops) — keyed by the new slot-instance ID.
   * The caller must add these to the tree before applying rename/delete ops.
   */
  newNodes: Record<string, BaseNode>
  /**
   * Final ordered list of slot-instance child IDs for the VC ref's children array.
   * The caller must set vcRefNode.children = orderedChildIds after applying ops.
   * This includes IDs from both existing (kept) and newly-inserted slot-instances.
   */
  orderedChildIds: string[]
}

// ---------------------------------------------------------------------------
// syncSlotInstances — pure function
// ---------------------------------------------------------------------------

/**
 * Compute the ops needed to bring a VC ref's slot-instance children into sync
 * with its referenced VC's slot params.
 *
 * Rules enforced:
 *   1. One slot-instance child per slot param (type === 'slot'), in param order.
 *   2. Each slot-instance's props.slotName matches its corresponding param.name.
 *   3. Removed slot params → delete their slot-instance AND cascade subtree.
 *   4. Non-slot-instance children of the VC ref → dropped (delete op).
 *   5. Every new slot-instance is created with locked: true.
 *
 * Matching strategy:
 *   a. Name-based (first priority): existing slot-instances matched by slotName →
 *      handles reorder (matched by name → just reorder, no rename/delete).
 *   b. Positional (fallback): remaining unmatched instances ↔ unmatched params →
 *      produces rename ops (handles the param-rename case).
 *   c. Remaining unmatched instances → delete ops.
 *   d. Remaining unmatched params → insert ops.
 *
 * Running on an already-synced ref produces an empty ops array and an
 * orderedChildIds that matches vcRefNode.children exactly (idempotent).
 *
 * This function is PURE — no Mutative producer, no store, no side effects.
 */
export function syncSlotInstances(
  vcRefNode: BaseNode,
  vc: VisualComponent,
  treeNodes: Record<string, BaseNode>,
): SyncResult {
  const ops: SyncOp[] = []
  const newNodes: Record<string, BaseNode> = {}

  // Slot names sourced directly from `base.slot-outlet` nodes in the VC tree
  // (the slot-outlet IS the slot — no separate vc.params slot entry required).
  // This is the single source of truth for "what slots does this VC declare?".
  const slotNames = collectSlotOutletNames(vc.tree)
  const targetNames = new Set(slotNames)

  // Classify existing children of the VC ref.
  const existingSlotInstances: Array<{ nodeId: string; slotName: string }> = []
  const invalidChildIds: string[] = []

  for (const childId of vcRefNode.children) {
    const child = treeNodes[childId]
    if (child?.moduleId === 'base.slot-instance') {
      const slotName =
        typeof child.props.slotName === 'string' && child.props.slotName
          ? child.props.slotName
          : ''
      existingSlotInstances.push({ nodeId: childId, slotName })
    } else {
      // Non-slot-instance child: drop it (invalid under a VC ref)
      invalidChildIds.push(childId)
    }
  }

  // Delete invalid (non-slot-instance) children.
  for (const nodeId of invalidChildIds) {
    ops.push({ kind: 'delete', nodeId })
  }

  // ── Phase 1: Name-based matching ─────────────────────────────────────────
  // Map slotName → nodeId for slot-instances that match a target param name.
  const matchedByName = new Map<string, string>() // slotName → nodeId
  const unmatchedInstances: Array<{ nodeId: string; slotName: string }> = []

  for (const { nodeId, slotName } of existingSlotInstances) {
    if (targetNames.has(slotName) && !matchedByName.has(slotName)) {
      matchedByName.set(slotName, nodeId)
    } else {
      unmatchedInstances.push({ nodeId, slotName })
    }
  }

  // ── Phase 2: Positional matching for rename detection ────────────────────
  // Pair remaining unmatched slot names with remaining unmatched instances by
  // position → produces rename ops (handles the slot-rename case cleanly).
  const unmatchedNames = slotNames.filter((name) => !matchedByName.has(name))
  const pairingCount = Math.min(unmatchedNames.length, unmatchedInstances.length)

  for (let i = 0; i < pairingCount; i++) {
    const targetName = unmatchedNames[i]
    const inst = unmatchedInstances[i]
    ops.push({ kind: 'rename', nodeId: inst.nodeId, newSlotName: targetName })
    matchedByName.set(targetName, inst.nodeId)
  }

  // ── Phase 3: Delete truly orphan instances ────────────────────────────────
  for (let i = pairingCount; i < unmatchedInstances.length; i++) {
    ops.push({ kind: 'delete', nodeId: unmatchedInstances[i].nodeId })
  }

  // ── Phase 4: Insert new slot-instances for unmatched slot names ──────────
  for (let i = pairingCount; i < unmatchedNames.length; i++) {
    const targetName = unmatchedNames[i]
    const slotInstanceId = nanoid()
    newNodes[slotInstanceId] = {
      id: slotInstanceId,
      moduleId: 'base.slot-instance',
      props: { slotName: targetName },
      children: [],
      breakpointOverrides: {},
      classIds: [],
      locked: true,
      // A slot-instance is always a direct child of its VC ref.
      parentId: vcRefNode.id,
    }
    ops.push({ kind: 'insert', slotInstanceId, slotName: targetName })
    matchedByName.set(targetName, slotInstanceId)
  }

  // ── Build ordered list (in VC tree DFS pre-order of slot-outlet appearance) ─
  const orderedChildIds = slotNames.map((name) => matchedByName.get(name)!)

  return { ops, newNodes, orderedChildIds }
}

// ---------------------------------------------------------------------------
// applySlotSyncResult — applies a SyncResult to a mutable nodes map
// ---------------------------------------------------------------------------

/**
 * Apply a SyncResult (from syncSlotInstances) to a mutable nodes map.
 *
 * Intended to be called inside a Mutative producer where `treeNodes` is a
 * Mutative draft (or a plain object in tests).
 *
 * Steps:
 *   1. Add newNodes entries to the tree.
 *   2. Apply rename ops (update props.slotName on existing slot-instances).
 *   3. Apply delete ops (cascade-delete the slot-instance and its subtree).
 *   4. Set vcRefNode.children = orderedChildIds.
 */
export function applySlotSyncResult(
  treeNodes: Record<string, BaseNode>,
  result: SyncResult,
  vcRefNodeId: string,
): void {
  // 1. Add new nodes
  for (const [id, node] of Object.entries(result.newNodes)) {
    treeNodes[id] = node
  }

  // 2 & 3. Apply ops
  for (const op of result.ops) {
    if (op.kind === 'rename') {
      const n = treeNodes[op.nodeId]
      if (n) {
        n.props = { ...n.props, slotName: op.newSlotName }
      }
    } else if (op.kind === 'delete') {
      // unlinkParent: false — the VC ref's children array is overwritten
      // wholesale below (step 4), so this must NOT touch the parent here.
      deleteSubtree(treeNodes, op.nodeId, { unlinkParent: false })
    }
    // insert ops: handled by adding to newNodes above
  }

  // 4. Set ordered children and re-point each slot-instance at the VC ref.
  const vcRefNode = treeNodes[vcRefNodeId]
  if (vcRefNode) {
    vcRefNode.children = result.orderedChildIds
    for (const childId of result.orderedChildIds) {
      const child = treeNodes[childId]
      if (child) child.parentId = vcRefNodeId
    }
  }
}
