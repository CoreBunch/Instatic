/**
 * Static hole-subtree module census.
 *
 * A `<instatic-hole>` placeholder defers its subtree to request time, so the
 * page render never executes those modules' render() — their `js` cannot land
 * in `RenderAccumulators.jsMap`. This walker statically gathers every moduleId
 * reachable inside the page's hole subtrees (descending through page-tree
 * children AND into referenced Visual Component definition trees,
 * cycle-guarded) so `publishPage` can report them as module-JS candidates.
 *
 * Over-inclusion is deliberate and cheap: the server intersects candidates
 * with the site-wide module-JS map before emitting any `<script>` tag, so a
 * module with no published JS costs nothing. Render-conditional emission
 * (e.g. `base.form` only emits in `cms` mode) cannot be evaluated for an
 * unbaked hole — membership is per-module, per the design spec.
 */
import type { Page, SiteDocument } from '@core/page-tree'
import { selectVisualComponentById } from '@core/page-tree'

/** Structural minimum shared by PageNode and VCNode for this walk. */
interface WalkNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  children?: string[]
}

export function collectHoleSubtreeAssets(
  page: Page,
  site: SiteDocument,
  dynamicNodeIds: ReadonlySet<string>,
) {
  const moduleIds = new Set<string>()
  const infiniteLoopIds = new Set<string>()

  const visit = (
    nodes: Record<string, WalkNode>,
    nodeId: string,
    seenVcs: ReadonlySet<string>,
  ): void => {
    const node = nodes[nodeId]
    if (!node) return
    moduleIds.add(node.moduleId)
    if (node.moduleId === 'base.loop' && node.props.pagination === 'infinite') infiniteLoopIds.add(node.id)
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId =
        typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
      if (componentId && !seenVcs.has(componentId)) {
        const vc = selectVisualComponentById(site, componentId)
        if (vc) {
          visit(
            vc.tree.nodes as Record<string, WalkNode>,
            vc.tree.rootNodeId,
            new Set(seenVcs).add(componentId),
          )
        }
      }
    }
    for (const childId of node.children ?? []) visit(nodes, childId, seenVcs)
  }

  for (const holeNodeId of dynamicNodeIds) {
    visit(page.nodes as Record<string, WalkNode>, holeNodeId, new Set())
  }
  return { moduleIds, infiniteLoopIds }
}
