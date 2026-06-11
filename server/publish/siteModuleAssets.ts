/**
 * Site-wide module-asset walk.
 *
 * Walks every page's node tree with the canonical render walker and returns
 * the shared accumulators — `cssMap` feeds the framework CSS bundle
 * (`siteCssBundle.ts`), `jsMap` feeds the published module-JS map
 * (`moduleJsBundle.ts`). One walker, two consumers, so the two channels can
 * never drift on traversal semantics.
 *
 * The HTML produced by `renderNode` is thrown away — discarding it is cheaper
 * than maintaining a separate assets-only walker that would drift from the
 * canonical render path over time. The accumulators are shared across pages,
 * so each module contributes at most one CSS and one JS entry for the whole
 * site even if it appears on every page.
 *
 * Known mirror of the CSS channel's semantics: loop bodies render empty here
 * (no prefetched loop data), so a module that appears ONLY inside loop bodies
 * contributes neither CSS nor JS — pre-existing behaviour, unchanged.
 */
import type { SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { renderNode } from '@core/publisher'
import type { RenderConfig, RenderAccumulators } from '@core/publisher'

export function collectSiteModuleAssets(
  site: SiteDocument,
  registry: IModuleRegistry,
): RenderAccumulators {
  const acc: RenderAccumulators = {
    cssMap: new Map<string, string>(),
    jsMap: new Map<string, string>(),
    infiniteLoopIds: new Set<string>(),
    holeNodeIds: new Set<string>(),
  }
  for (const page of site.pages) {
    const config: RenderConfig = {
      page,
      site,
      registry,
      breakpointId: undefined,
    }
    renderNode(page.rootNodeId, config, acc)
  }
  return acc
}
