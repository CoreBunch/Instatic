import type { AnyModuleDefinition, ModuleAssetUsage } from '@core/module-engine-schema'
import { sanitizeModuleCSS } from './cssCollector'
import type { RenderAccumulators } from './renderConfig'

export type ModuleAssetMaps = Pick<RenderAccumulators, 'cssMap' | 'jsMap'>

/** One payload owner for site reachability and actual per-instance emission. */
export function collectModuleAssets(
  definition: AnyModuleDefinition,
  maps: ModuleAssetMaps,
  usage?: ModuleAssetUsage,
): void {
  const assets = definition.assets
  if (assets?.css && usage?.css !== false && !maps.cssMap.has(definition.id)) {
    maps.cssMap.set(definition.id, sanitizeModuleCSS(assets.css))
  }
  if (assets?.js && usage?.js !== false && !maps.jsMap.has(definition.id)) {
    maps.jsMap.set(definition.id, assets.js)
  }
}
