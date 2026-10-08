import type { Page } from '@core/page-tree'
import type { PublishedDataRow } from '@core/data/schemas'
import {
  buildTemplateRenderContext,
  composeTemplateChain,
  resolveTemplateChain,
  type TemplateRenderDataContext,
} from '@core/templates'
import { buildRouteFrame } from '@core/templates/contextFrames'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { publishedDataRowToLoopItem } from './loopPrefetch'

export interface PublishedRenderContext {
  page: Page
  templateContext: TemplateRenderDataContext
}

/** Full pages and fragments share the same composed tree and authoritative frames. */
export function buildPublishedPageRenderContext(
  snapshot: PublishedPageSnapshot,
  page: Page,
  url?: URL,
): PublishedRenderContext {
  const chain = resolveTemplateChain(snapshot.site, { kind: 'page' })
  const merged = composeTemplateChain(chain, { kind: 'page', page })
  return {
    page: merged,
    templateContext: buildTemplateRenderContext(page, snapshot.site, {
      entryStack: [],
      ...(url ? { route: buildRouteFrame(url.toString()) } : {}),
    }),
  }
}

/** Entry routes seed the published row before any loop iteration is appended. */
export function buildPublishedEntryRenderContext(
  snapshot: PublishedPageSnapshot,
  row: PublishedDataRow,
  url?: URL,
): PublishedRenderContext | null {
  const chain = resolveTemplateChain(snapshot.site, { kind: 'entry', tableSlug: row.tableSlug })
  if (chain.length === 0) return null
  const merged = composeTemplateChain(chain, { kind: 'entry' })
  if (typeof row.cells.title === 'string') merged.title = row.cells.title
  return {
    page: merged,
    templateContext: buildTemplateRenderContext(merged, snapshot.site, {
      entryStack: [publishedDataRowToLoopItem(row)],
      ...(url ? { route: buildRouteFrame(url.toString()) } : {}),
    }),
  }
}
