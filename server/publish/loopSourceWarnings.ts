/**
 * Loops that publish as nothing because nobody provides their source.
 *
 * A loop keeps its `sourceId` when the plugin behind it is disabled or
 * removed, and the publisher renders such a loop as an empty list. That is
 * correct output, but an author whose editor still shows the plugin's sample
 * items cannot see it coming, so the site publish says it.
 *
 * Only loops the publish renders are reported: `collectLoopNodes` walks each
 * page the way the publisher does (`walkRenderTree`), so a hidden loop, a
 * loop under a hidden parent, a node no longer reachable from the page root
 * and a Visual Component no page uses are all left out, and a loop inside a
 * Visual Component counts for each page that uses it.
 *
 * There is one warning per missing source, with how many pages it affects
 * and the first few of them by name: a component used on hundreds of pages
 * is one line, and cannot crowd a second missing source out of the list.
 */
// Registers the built-in sources: without them every loop would look unprovided.
import '@core/loops/sources'
import { loopSourceRegistry } from '@core/loops'
import type { SiteDocument } from '@core/page-tree'
import {
  CMS_PUBLISH_WARNING_PAGES_NAMED,
  CMS_PUBLISH_WARNINGS_LISTED,
  type CmsPublishWarning,
} from '@core/persistence/responseSchemas'
import { collectLoopNodes } from './loopPrefetch'

export interface PublishWarnings {
  /** The first `CMS_PUBLISH_WARNINGS_LISTED` of them. */
  warnings: CmsPublishWarning[]
  /** How many there are in all. */
  warningsTotal: number
}

const NONE: PublishWarnings = { warnings: [], warningsTotal: 0 }

/**
 * One warning per missing source, for the pages of a site that was just
 * published. Never throws: the publish is committed by now, and a failure to
 * describe it must not make it look failed.
 */
export function unavailableLoopSourceWarnings(site: SiteDocument): PublishWarnings {
  try {
    const pagesBySource = new Map<string, string[]>()
    for (const page of site.pages) {
      const missing = new Set<string>()
      for (const loop of collectLoopNodes(page, site)) {
        const sourceId = typeof loop.props.sourceId === 'string' ? loop.props.sourceId : ''
        if (sourceId && !loopSourceRegistry.has(sourceId)) missing.add(sourceId)
      }
      for (const sourceId of missing) {
        const pages = pagesBySource.get(sourceId)
        if (pages) pages.push(page.title)
        else pagesBySource.set(sourceId, [page.title])
      }
    }
    const all: CmsPublishWarning[] = [...pagesBySource].map(([sourceId, pages]) => ({
      kind: 'loop-source-unavailable',
      sourceId,
      pages: pages.slice(0, CMS_PUBLISH_WARNING_PAGES_NAMED),
      pageCount: pages.length,
    }))
    return { warnings: all.slice(0, CMS_PUBLISH_WARNINGS_LISTED), warningsTotal: all.length }
  } catch (err) {
    console.error('[publish] could not check the published loops for missing sources:', err)
    return NONE
  }
}
