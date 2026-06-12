/**
 * instantiateVCAtRef — produce a flat node tree for inline rendering of a VC instance.
 *
 * Architecture source: Contribution #619 §8.5
 *
 * Given a VC definition, per-instance `propOverrides` (keyed by VCParam.id),
 * `slotInstancesByName` (keyed by slotName → direct child node IDs from the
 * consumer's page tree), and the full `pageNodes` map for resolving slot content
 * subtrees, returns a flat `nodes` map ready for VCInlineTree to render.
 *
 * Responsibilities:
 *  - Walk the VC's flat tree (vc.tree.nodes) starting from vc.tree.rootNodeId
 *  - Apply propBindings: for each node.propBindings[propKey] = { paramId },
 *    substitute node.props[propKey] with the effective param value
 *    (propOverrides[paramId] ?? param.defaultValue)
 *  - Expand slot outlets: base.slot-outlet nodes are replaced with
 *    slotInstancesByName[slotName] content (if provided) or the slot param's
 *    defaultValue (if set), or kept as a placeholder.
 *  - base.visual-component-ref nodes pass through unchanged — VCInlineTree
 *    delegates them to VisualComponentRefEditor for recursive rendering.
 *
 * Constraint #269: This file must NOT import from editor/ or editor-store/.
 */

import { Type } from '@sinclair/typebox'
import type { BaseNode } from '@core/page-tree'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import type { VisualComponent, VCNode } from './schemas'
import { VCNodeSchema } from './schemas'

const VCNodeArraySchema = Type.Array(VCNodeSchema)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A flattened VCNode annotated with in-memory Phase 4 canvas metadata.
 * These fields are NEVER persisted — they are computed fresh on every
 * instantiateVCAtRef call and exist solely for canvas selection utilities.
 */
export interface InstantiatedVCNode extends VCNode {
  /** ID of the page-level base.visual-component-ref node that owns this inlined node */
  _owningRefId: string
  /**
   * True when this node came from the consumer's slot content (user-authored
   * content that is editable in page context). False when it came from the VC body
   * (template-owned content, not directly editable on the page).
   */
  _fromSlotContent: boolean
}

interface InstantiatedVC {
  /** Flat map of all nodes in the rendered instance */
  nodes: Record<string, InstantiatedVCNode>
  /** ID of the root node — entry point for VCInlineTree */
  rootNodeId: string
}

// ---------------------------------------------------------------------------
// instantiateVCAtRef
// ---------------------------------------------------------------------------

/**
 * Instantiate a VisualComponent at a reference site.
 *
 * @param vc                  - The VC definition to instantiate.
 * @param propOverrides       - Per-param value overrides, keyed by VCParam.id.
 * @param slotInstancesByName - Per-slot direct child node IDs from the consumer's
 *                              page tree, keyed by slotName. These are the IDs of
 *                              the immediate children of each slot-instance node.
 * @param pageNodes           - The consumer's full page nodes map. Used to
 *                              recursively collect all slot content descendants.
 * @param refId               - ID of the page-level base.visual-component-ref node.
 *                              Every emitted node is annotated with this id.
 * @returns Flat node map + root node ID for VCInlineTree.
 */
export function instantiateVCAtRef(
  vc: VisualComponent,
  propOverrides: Record<string, unknown>,
  slotInstancesByName: Record<string, string[]>,
  pageNodes: Record<string, BaseNode>,
  refId: string,
): InstantiatedVC {
  const nodes: Record<string, InstantiatedVCNode> = {}

  // Build a paramId → effectiveValue map for O(1) lookups during tree walk.
  const paramValues = new Map<string, unknown>()
  for (const param of vc.params) {
    const effective = Object.prototype.hasOwnProperty.call(propOverrides, param.id)
      ? propOverrides[param.id]
      : param.defaultValue
    paramValues.set(param.id, effective)
  }

  /**
   * Recursively register a page-tree slot content node (and all descendants)
   * into the flat output map, marking them as _fromSlotContent = true.
   *
   * Slot content nodes are in the page tree (flat map via pageNodes). We walk
   * the subtree recursively using their children[] ID arrays.
   */
  function registerSlotContentNode(nodeId: string): void {
    const node = pageNodes[nodeId]
    if (!node || nodes[node.id]) return // skip missing or already-registered
    nodes[node.id] = {
      ...node,
      _owningRefId: refId,
      _fromSlotContent: true,
    } as InstantiatedVCNode
    for (const childId of node.children) {
      registerSlotContentNode(childId)
    }
  }

  /**
   * Process a VC tree node by ID (flat-map walk via vc.tree.nodes).
   * Returns the array of node IDs to use in the parent's children list
   * (usually [nodeId], but a slot outlet may expand to multiple IDs).
   * All nodes emitted via this path are marked _fromSlotContent = false.
   */
  function processNode(nodeId: string): string[] {
    const node = vc.tree.nodes[nodeId]
    if (!node) return []

    // ── Slot outlet expansion ──────────────────────────────────────────────
    if (node.moduleId === 'base.slot-outlet') {
      const slotName =
        typeof node.props.slotName === 'string' && node.props.slotName
          ? node.props.slotName
          : 'children'

      // Check slot-instance children from the consumer's page tree first.
      const instanceChildIds = slotInstancesByName[slotName]
      if (instanceChildIds && instanceChildIds.length > 0) {
        // Register all slot content nodes and their descendants.
        for (const childId of instanceChildIds) {
          registerSlotContentNode(childId)
        }
        return instanceChildIds
      }

      // Fall back to slot param defaultValue (VCNode[] format).
      const paramDefault = vc.params.find((p) => p.type === 'slot' && p.name === slotName)
      const defaultContentResult = Array.isArray(paramDefault?.defaultValue)
        ? compiledCheck(VCNodeArraySchema, paramDefault.defaultValue)
        : false
      const defaultContent: VCNode[] = defaultContentResult
        ? (paramDefault!.defaultValue as VCNode[])
        : []

      if (defaultContent.length > 0) {
        // Register default content nodes (flat VCNode format, no childNodes).
        for (const defaultNode of defaultContent) {
          registerDefaultVCNode(defaultNode)
        }
        return defaultContent.map((n) => n.id)
      }

      // No content — keep slot outlet as placeholder.
      nodes[node.id] = {
        ...node,
        _owningRefId: refId,
        _fromSlotContent: false,
      }
      return [node.id]
    }

    // ── Prop binding substitution ──────────────────────────────────────────
    let props = node.props
    if (node.propBindings && Object.keys(node.propBindings).length > 0) {
      const patched: Record<string, unknown> = { ...node.props }
      for (const [propKey, binding] of Object.entries(node.propBindings)) {
        if (paramValues.has(binding.paramId)) {
          patched[propKey] = paramValues.get(binding.paramId)
        }
      }
      props = patched
    }

    // ── Recurse into children (flat-map IDs) ──────────────────────────────
    const effectiveChildren: string[] = []
    for (const childId of node.children) {
      const childIds = processNode(childId)
      effectiveChildren.push(...childIds)
    }

    // Register this node with resolved props and effective children.
    nodes[node.id] = {
      ...node,
      props,
      children: effectiveChildren,
      _owningRefId: refId,
      _fromSlotContent: false,
    }

    return [node.id]
  }

  /**
   * Register a VCNode from a slot param defaultValue (flat VCNode format).
   * These nodes are stored as plain VCNode objects (no childNodes — VCNode
   * is now always flat). Marks as _fromSlotContent = true.
   */
  function registerDefaultVCNode(node: VCNode): void {
    if (nodes[node.id]) return
    nodes[node.id] = {
      ...node,
      _owningRefId: refId,
      _fromSlotContent: true,
    }
    for (const childId of node.children) {
      const childNode = vc.tree.nodes[childId]
      if (childNode) registerDefaultVCNode(childNode)
    }
  }

  processNode(vc.tree.rootNodeId)

  return { nodes, rootNodeId: vc.tree.rootNodeId }
}
