import type { Page, SiteDocument } from '@core/page-tree'
import { walkRenderTree } from '@core/visualComponents'

/**
 * Hole contents render only with the actual request. Census their reachable
 * types through the same component/slot walker as the site asset collector;
 * the server intersects these candidates with declared module JS payloads.
 */
export function collectHoleSubtreeModuleIds(
  page: Page,
  site: SiteDocument,
  dynamicNodeIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>()
  for (const holeNodeId of dynamicNodeIds) {
    walkRenderTree(page.nodes, holeNodeId, site.visualComponents, (node) => {
      out.add(node.moduleId)
    })
  }
  return out
}
