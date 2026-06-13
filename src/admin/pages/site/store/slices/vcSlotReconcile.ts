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
