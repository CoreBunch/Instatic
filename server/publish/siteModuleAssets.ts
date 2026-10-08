import type { SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { collectModuleAssets, type ModuleAssetMaps } from '@core/publisher'
import { publishedRenderScopes } from '@core/templates'
import { walkRenderTree } from '@core/visualComponents'

/**
 * Collect invariant type assets from public render scopes. This structural
 * walk includes materialized components, selected slot fills and loop variants
 * even when a loop currently has no rows. It never invokes render(), parses
 * instance props, fetches data, or invents an entry/request context.
 */
export function collectSiteModuleAssets(
  site: SiteDocument,
  registry: IModuleRegistry,
): ModuleAssetMaps {
  const maps: ModuleAssetMaps = { cssMap: new Map(), jsMap: new Map() }
  for (const scope of publishedRenderScopes(site)) {
    walkRenderTree(scope.page.nodes, scope.page.rootNodeId, site.visualComponents, (node) => {
      const definition = registry.get(node.moduleId)
      if (definition) collectModuleAssets(definition, maps)
    })
  }
  return maps
}
