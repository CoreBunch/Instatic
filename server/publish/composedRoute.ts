/**
 * The composed tree a public URL renders: the routed page (or entry, or the
 * 404 page) spliced into its layout chain, exactly as the public renderer
 * builds it.
 *
 * The fragment endpoints (`/_instatic/hole/<id>`, `/_instatic/loop/<id>`)
 * render one node of a page that was already served. The ids they are asked
 * for are the ids of the COMPOSED tree: page content under a layout carries a
 * composition prefix (`c0_<id>`), and a layout element around the outlet
 * holds the page content. Rendering such a node from the raw page or the raw
 * layout finds nothing, or an element with nothing in it. So both endpoints
 * resolve the caller's page URL to this composed tree first, with the same
 * entry the public renderer seeds for an entry route.
 *
 * The URL is chosen by the caller. It only ever narrows what can be rendered
 * (a node must be in the tree of the route it names), and the route's access
 * rules apply to the fragment.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { LoopItem } from '@core/loops/types'
import type { AccessRule } from '@core/members'
import {
  composeTemplateChain,
  isTemplatePage,
  resolveNotFoundTemplate,
  resolveTemplateChain,
} from '@core/templates'
import type { DbClient } from '../db/client'
import { MAIN_SCOPE } from '../branches/scope'
import { getDataTable } from '../repositories/data'
import { getPublishedDataRowByRoute } from '../repositories/data/publish'
import { pageRules, tableRulesForRouteBase, type AccessIndex } from './accessGate'
import { publishedDataRowToEntryItem } from './loopPrefetch'
import { contentRouteFromPath, publicSlugFromPath } from './publicRouter'

export interface ComposedRoute {
  /** The composed tree, as `publishPage` renders it for this route. */
  page: Page
  /** The id of the routed page or entry template (form page tokens are stamped with it). */
  ownerId: string
  /** The entry an entry route renders, the seed of `currentEntry`; empty otherwise. */
  entryStack: LoopItem[]
  /** The routed content's own access rules (page, or the entry's table). */
  rules: (index: AccessIndex) => AccessRule[]
}

/**
 * Resolve `pathname` against the published `site` the way the public router
 * does: a page at the slug, then a published entry at `<route-base>/<slug>`,
 * then the 404 page. `null` when none of them exists.
 */
export async function composedRouteForPath(
  db: DbClient,
  site: SiteDocument,
  pathname: string,
): Promise<ComposedRoute | null> {
  const slug = publicSlugFromPath(pathname)
  const page = site.pages.find((candidate) => candidate.slug === slug && !isTemplatePage(candidate))
  if (page) {
    return {
      page: composeTemplateChain(resolveTemplateChain(site, { kind: 'page' }), { kind: 'page', page }),
      ownerId: page.id,
      entryStack: [],
      rules: (index) => pageRules(index, page),
    }
  }

  const route = contentRouteFromPath(pathname)
  const row = route ? await getPublishedDataRowByRoute(db, route.tableRouteBase, route.rowSlug) : null
  if (row) {
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: row.tableSlug })
    if (chain.length > 0) {
      const composed = composeTemplateChain(chain, { kind: 'entry' })
      const table = await getDataTable(db, MAIN_SCOPE, row.tableId)
      return {
        page: composed,
        ownerId: composed.id,
        entryStack: [await publishedDataRowToEntryItem(db, row, table?.fields ?? [])],
        rules: (index) => tableRulesForRouteBase(index, row.tableRouteBase),
      }
    }
  }

  const notFound = resolveNotFoundTemplate(site)
  if (!notFound) return null
  return {
    page: composeTemplateChain(resolveTemplateChain(site, { kind: 'page' }), { kind: 'page', page: notFound }),
    ownerId: notFound.id,
    entryStack: [],
    rules: () => [],
  }
}
