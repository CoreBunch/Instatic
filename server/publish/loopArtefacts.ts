/**
 * Layer A invalidation for baked HTML that lists a table's rows.
 *
 * A full publish bakes every page, including the output of static `base.loop`
 * nodes. Layer A then serves that file with no knowledge of the publish
 * version, so a row that is published, unpublished or deleted afterwards
 * leaves every page that loops over its table listing the old rows.
 *
 * `removeArtefactsLoopingOverTable` drops those files from the ACTIVE slot.
 * The routes then fall through to Layer B, whose render cache every row change
 * already evicts by bumping the publish version, so the next visitor gets a
 * live render and later changes to the table need no further disk work. The
 * next full publish bakes them again.
 *
 * Removing rather than re-baking keeps the cost of a row publish independent
 * of how much of the site lists the table: a loop in an `everywhere` layout
 * makes every page and every entry route dependent, and re-rendering all of
 * them on each row publish would be a full site bake under the publish lock.
 *
 * "Loops over the table" follows the same render tree the publisher walks:
 * the page itself, every template in its chain, and the Visual Components any
 * of them reference (`collectLoopNodes` → `walkRenderTree`). Routes whose tree
 * holds no such loop are left on disk.
 */
import type { Page, SiteDocument } from '@core/page-tree'
import { isTemplatePage, resolveNotFoundTemplate, resolveTemplateChain } from '@core/templates'
import type { DbClient } from '../db/client'
import { listPublishedRowRoutes, publicDataPath } from '../repositories/data/publish'
import { collectLoopNodes, readLoopProps } from './loopPrefetch'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { getPublishVersion } from './publishState'
import {
  NOT_FOUND_ARTEFACT_URL_PATH,
  pageArtefactUrlPath,
  removeArtefactsInPlace,
} from './staticArtefact'

/** Registry id of the built-in source that iterates a data table's rows. */
const DATA_ROWS_SOURCE_ID = 'data.rows'

/**
 * Answers "does this page's own render tree loop over `tableId`?", memoised
 * per page so a template shared by many routes is walked once.
 */
function createLoopLookup(site: SiteDocument, tableId: string): (page: Page) => boolean {
  const known = new Map<string, boolean>()
  return (page) => {
    const cached = known.get(page.id)
    if (cached !== undefined) return cached
    const loops = collectLoopNodes(page, site).some((node) => {
      const props = readLoopProps(node)
      return props.sourceId === DATA_ROWS_SOURCE_ID && props.filters.tableId === tableId
    })
    known.set(page.id, loops)
    return loops
  }
}

/**
 * Public URL paths of every baked artefact whose render tree loops over
 * `tableId` in the published `site`.
 */
async function artefactPathsLoopingOverTable(
  db: DbClient,
  site: SiteDocument,
  tableId: string,
): Promise<string[]> {
  const loopsOverTable = createLoopLookup(site, tableId)
  const paths: string[] = []

  // Pages, and the 404 page: each is wrapped by the `page` template chain.
  const pageChainLoops = resolveTemplateChain(site, { kind: 'page' }).some(loopsOverTable)
  for (const page of site.pages) {
    if (isTemplatePage(page)) continue // never baked at its own slug
    if (pageChainLoops || loopsOverTable(page)) paths.push(pageArtefactUrlPath(page.slug))
  }
  const notFound = resolveNotFoundTemplate(site)
  if (notFound && (pageChainLoops || loopsOverTable(notFound))) paths.push(NOT_FOUND_ARTEFACT_URL_PATH)

  // Entry routes render through templates only, so they can depend on the
  // table only when some template loops over it. Skip the row listing if not.
  if (!site.pages.some((page) => isTemplatePage(page) && loopsOverTable(page))) return paths

  const entryChainLoops = new Map<string, boolean>()
  for (const route of await listPublishedRowRoutes(db)) {
    let loops = entryChainLoops.get(route.tableSlug)
    if (loops === undefined) {
      loops = resolveTemplateChain(site, { kind: 'entry', tableSlug: route.tableSlug }).some(loopsOverTable)
      entryChainLoops.set(route.tableSlug, loops)
    }
    if (loops) paths.push(publicDataPath(route.tableRouteBase, route.rowSlug))
  }
  return paths
}

/**
 * Remove from the active slot every baked artefact that loops over `tableId`,
 * so those routes are rendered live against the table's current rows.
 *
 * Call it under the publish lock, after the row change has committed: the
 * active slot must not be swapped by a full publish between resolving it and
 * unlinking from it. A site that has never been published has no artefacts
 * and is a no-op.
 */
export async function removeArtefactsLoopingOverTable(
  db: DbClient,
  uploadsDir: string,
  tableId: string,
): Promise<void> {
  // The published site only changes with a full publish, so the snapshot
  // memoised for the current version is the one the active slot was baked from.
  const snapshot = await getLatestSnapshotForVersion(db, getPublishVersion())
  if (!snapshot) return
  const paths = await artefactPathsLoopingOverTable(db, snapshot.site, tableId)
  await removeArtefactsInPlace(uploadsDir, paths)
}
