import type { Page, SiteDocument } from '@core/page-tree'
import type { LoopItem } from '@core/loops/types'
import { composeTemplateChain, resolveNotFoundTemplate, resolveTemplateChain } from '@core/templates'
import type { DbClient } from '../db/client'
import { MAIN_SCOPE } from '../branches/scope'
import { getDataTable } from '../repositories/data'
import { publishedDataRowToEntryItem } from './loopPrefetch'
import { resolvePublicRoute } from './publicRouter'
import { getPublishedSnapshotHash } from './publishedSnapshotCache'

/** Rebuild the tree for the originating published route using the frozen site. */
export async function composedRouteForPath(db: DbClient, url: URL, site: SiteDocument): Promise<{ page: Page; entryStack: LoopItem[] } | null> {
  const resolution = await resolvePublicRoute(db, url)
  if (resolution.kind === 'redirect') return null
  if (resolution.kind !== 'not-found' && getPublishedSnapshotHash(resolution.snapshot.site) !== getPublishedSnapshotHash(site)) {
    return null
  }
  if (resolution.kind === 'row') {
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: resolution.row.tableSlug })
    if (!chain.length) return null
    const tree = composeTemplateChain(chain, { kind: 'entry' })
    const title = resolution.row.cells.title
    const table = await getDataTable(db, MAIN_SCOPE, resolution.row.tableId)
    const entry = await publishedDataRowToEntryItem(db, resolution.row, table?.fields ?? [])
    return { page: typeof title === 'string' ? { ...tree, title } : tree, entryStack: [entry] }
  }
  const page = resolution.kind === 'page'
    ? site.pages.find((candidate) => candidate.id === resolution.snapshot.pageRowId)
    : resolveNotFoundTemplate(site)
  if (!page) return null
  const tree = composeTemplateChain(resolveTemplateChain(site, { kind: 'page' }), { kind: 'page', page })
  // The document frame, access rules and form tokens belong to the served
  // page; only the tree structure comes from the surrounding layout.
  return { page: { ...page, rootNodeId: tree.rootNodeId, nodes: tree.nodes }, entryStack: [] }
}
