/**
 * Full-publish baking of data-row Layer A artefacts.
 *
 * A full publish wipes the inactive slot, writes every page artefact, and
 * swaps — which used to strand every row artefact (`/posts/hello-world`)
 * that incremental publishes had written into the previously-active slot.
 * After every full publish, ALL row routes fell back to the live renderer
 * until each row was individually republished.
 *
 * `bakePublishedDataRowArtefacts` closes that hole: it enumerates every
 * published data row whose table has an entry-template chain and bakes its
 * HTML into the given (still-inactive) slot directory, through the exact
 * render path the live fallback uses — `renderPublishedDataRowTemplate` +
 * `applyPublishedHtmlPipeline` — stamped with the publish version that
 * becomes current at the swap. Output bytes are identical to a live render;
 * only the serving tier changes.
 *
 * Every selected route must render successfully before the full publication
 * transaction starts. Failed rows abort the generation, keeping the previous
 * publication active.
 */

import type { DbClient } from '../db/client'
import type { SiteCssBundle } from '@core/publisher'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { resolveTemplateChain } from '@core/templates'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import {
  getPublishedDataRowByRoute,
  listPublishedRowRoutes,
} from '../repositories/data/publish'
import { renderPublishedDataRowTemplate } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import { writeArtefact } from './staticArtefact'

interface DataRowBakeResult {
  /** Routes successfully baked into the slot. */
  baked: number
  /**
   * CSS bundles referenced by the baked HTML. The caller writes their files
   * into the slot alongside the page bundles — entry-template renders can
   * carry a merged-page `userStyles` hash no raw page bundle produces.
   */
  cssBundles: SiteCssBundle[]
}

function publicRowPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

/**
 * Bake every published data-row route into `slotDir`. Called by the full
 * publish BEFORE its transaction commits. Prepared page snapshots supply the
 * new site and the exact entry template's runtime assets; data rows retain
 * their already-published versions until separately published.
 *
 * `publishVersion` is the NEXT publish version — the bake runs before
 * `bumpPublishVersion()`, so baked hole shells must carry the version that
 * becomes current at the swap. Staging must not populate published snapshot
 * memos with a generation that may still fail before publication.
 */
export async function bakePublishedDataRowArtefacts(
  db: DbClient,
  slotDir: string | undefined,
  publishVersion: number,
  pageSnapshots: readonly PublishedPageSnapshot[],
): Promise<DataRowBakeResult> {
  const result: DataRowBakeResult = { baked: 0, cssBundles: [] }

  const routes = await listPublishedRowRoutes(db)
  if (routes.length === 0) return result

  const siteSnapshot = pageSnapshots[0]
  if (!siteSnapshot) return result

  // Tables without an entry-template chain have no public row routes —
  // resolve once per table, not once per row.
  const tableHasChain = new Map<string, boolean>()
  const hasEntryChain = (tableSlug: string): boolean => {
    const known = tableHasChain.get(tableSlug)
    if (known !== undefined) return known
    const chain = resolveTemplateChain(siteSnapshot.site, { kind: 'entry', tableSlug })
    const has = chain.length > 0
    tableHasChain.set(tableSlug, has)
    return has
  }

  for (const route of routes) {
    if (!hasEntryChain(route.tableSlug)) continue
    const urlPath = publicRowPath(route.tableRouteBase, route.rowSlug)
    const row = await getPublishedDataRowByRoute(db, route.tableRouteBase, route.rowSlug)
    if (!row) throw new Error(`The prepared published row disappeared: ${urlPath}`)
    const syntheticUrl = new URL(`http://localhost${urlPath}`)
    // Runtime assets come from this table's entry template, not from the
    // arbitrary page the site-wide snapshot happens to name.
    const chain = resolveTemplateChain(siteSnapshot.site, { kind: 'entry', tableSlug: route.tableSlug })
    const innermost = chain[chain.length - 1]
    const snapshot = pageSnapshots.find((candidate) => candidate.pageRowId === innermost.id)
    if (!snapshot) throw new Error(`The prepared entry template is missing: ${urlPath}`)
    const rendered = await renderPublishedDataRowTemplate(snapshot, row, {
      db,
      url: syntheticUrl,
      publishVersion,
    })
    if (!rendered) throw new Error(`The prepared entry template did not render: ${urlPath}`)
    const html = await applyPublishedHtmlPipeline(rendered, db)
    if (slotDir) await writeArtefact(slotDir, urlPath, html)
    result.cssBundles.push(rendered.cssBundle)
    result.baked++
  }

  return result
}
