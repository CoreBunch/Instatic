import type { BaseNode, SiteDocument } from '@core/page-tree'
import { selectVisualComponentById } from '@core/page-tree'

/**
 * Walk a render tree from `rootNodeId`, invoking `onNode` for every node that
 * actually renders — page nodes AND nodes inside referenced Visual Component
 * definition trees.
 *
 * A `base.visual-component-ref` descends into its VC's tree (whose node ids are
 * preserved by `instantiateVCAtRef`, so the keys collected here match the
 * synthetic page rendered for that ref) and then continues into the ref's own
 * children (the slot-instance fills, which live in the page tree). A cycle
 * guard keyed on the VC ids already entered prevents infinite recursion when a
 * VC (transitively) references itself.
 *
 * Single source of truth for "which nodes contribute to a rendered page" so
 * loop-prefetch and media-prefetch can't drift from each other (ISS-022).
 */
export function walkRenderTree(
  nodes: Record<string, BaseNode>,
  rootNodeId: string,
  site: SiteDocument,
  onNode: (node: BaseNode, ancestors: readonly BaseNode[]) => void,
): void {
  const visit = (
    curNodes: Record<string, BaseNode>,
    nodeId: string,
    seenVcs: ReadonlySet<string>,
    ancestors: readonly BaseNode[],
  ): void => {
    const node = curNodes[nodeId]
    if (!node) return
    onNode(node, ancestors)
    const childAncestors = [...ancestors, node]

    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = (node.props as Record<string, unknown> | undefined)?.['componentId']
      if (typeof componentId === 'string' && componentId && !seenVcs.has(componentId)) {
        const vc = selectVisualComponentById(site, componentId)
        if (vc) {
          const nextSeen = new Set(seenVcs).add(componentId)
          visit(vc.tree.nodes as Record<string, BaseNode>, vc.tree.rootNodeId, nextSeen, childAncestors)
        }
      }
    }

    for (const childId of node.children) visit(curNodes, childId, seenVcs, childAncestors)
  }

  visit(nodes, rootNodeId, new Set(), [])
}
