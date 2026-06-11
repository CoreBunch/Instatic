/**
 * Slot-instance reconciliation helpers for Visual Component edits.
 *
 * Split out of `visualComponentsSlice.ts` (which owns the slice actions) so the
 * tree-sweeping logic — which must cover pages AND every VC tree, including refs
 * nested inside other VCs (ISS-026) — lives in one focused module.
 */

import type { BaseNode, PageNode } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { syncSlotInstances, applySlotSyncResult } from '@core/visualComponents'

/**
 * Collect the ordered, deduplicated slot names declared by `base.slot-outlet`
 * nodes in a VC tree — DFS pre-order, first appearance wins, missing/empty
 * `slotName` defaults to 'children'.
 *
 * Mirrors the (unexported) `extractSlotNamesFromVCTree` inside
 * `@core/visualComponents`' slotSync. This sequence is the ONLY input
 * `syncSlotInstances` reads from the VC, so callers can compare pre/post
 * sequences and skip a guaranteed no-op reconcile sweep when they are equal
 * (see `runActiveTreeRecipe` in `site/helpers.ts`).
 */
export function collectVCSlotOutletNames(tree: {
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

/**
 * Re-sync slot-instance children for every `base.visual-component-ref` that
 * references `vcId`, across all supplied node maps. Must run inside a Mutative
 * producer — each map is mutated in place via `applySlotSyncResult`.
 */
export function syncAllVCRefSlotInstances(
  nodeMaps: Array<Record<string, BaseNode>>,
  vcId: string,
  vc: VisualComponent,
): void {
  for (const treeNodes of nodeMaps) {
    for (const node of Object.values(treeNodes)) {
      if (
        node.moduleId === 'base.visual-component-ref' &&
        node.props.componentId === vcId
      ) {
        const syncResult = syncSlotInstances(node, vc, treeNodes)
        applySlotSyncResult(treeNodes, syncResult, node.id)
      }
    }
  }
}

/**
 * Every node map that can host a VC ref: each page's nodes AND each VC's tree
 * nodes. A slot edit on one VC must reconcile refs to it wherever they live,
 * including refs nested inside *other* VC trees (ISS-026).
 */
export function allTreeNodeMaps(site: {
  pages: Array<{ nodes: Record<string, PageNode> }>
  visualComponents: Array<{ tree: { nodes: Record<string, BaseNode> } }>
}): Array<Record<string, BaseNode>> {
  return [
    ...site.pages.map((p) => p.nodes as Record<string, BaseNode>),
    ...site.visualComponents.map((vc) => vc.tree.nodes),
  ]
}
