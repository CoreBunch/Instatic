/**
 * Loops that publish as nothing because nobody provides their source.
 *
 * A loop keeps its `sourceId` when the plugin behind it is disabled or
 * removed, and the publisher renders such a loop as an empty list. That is
 * correct output, but an author whose editor still shows the plugin's sample
 * items cannot see it coming, so the publish says it: one warning per page
 * or component and missing source.
 */
import { loopSourceRegistry } from '@core/loops'
import type { SiteDocument } from '@core/page-tree'
import type { CmsPublishWarning } from '@core/persistence/responseSchemas'

interface NodeLike {
  moduleId: string
  props: Record<string, unknown>
}

function missingSourceIds(nodes: Record<string, NodeLike>): string[] {
  const missing = new Set<string>()
  for (const node of Object.values(nodes)) {
    if (node.moduleId !== 'base.loop') continue
    const sourceId = typeof node.props.sourceId === 'string' ? node.props.sourceId : ''
    if (sourceId && !loopSourceRegistry.has(sourceId)) missing.add(sourceId)
  }
  return [...missing]
}

/**
 * Warnings for the pages just published. `pageIds` narrows them to those
 * pages (a single page's publish); every Visual Component is checked either
 * way, since any page may use it.
 */
export function unavailableLoopSourceWarnings(
  site: SiteDocument,
  pageIds?: ReadonlySet<string>,
): CmsPublishWarning[] {
  const warnings: CmsPublishWarning[] = []
  for (const page of site.pages) {
    if (pageIds && !pageIds.has(page.id)) continue
    for (const sourceId of missingSourceIds(page.nodes)) {
      warnings.push({ kind: 'loop-source-unavailable', where: page.title, sourceId })
    }
  }
  for (const component of site.visualComponents) {
    for (const sourceId of missingSourceIds(component.tree.nodes)) {
      warnings.push({ kind: 'loop-source-unavailable', where: component.name, sourceId })
    }
  }
  return warnings
}
