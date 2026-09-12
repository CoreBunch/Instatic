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
 * One bad row never aborts the bake: per-row failures are logged and the
 * route falls through to the live renderer at request time, mirroring the
 * per-page bake behaviour in `publishDraftSite`.
 */

import type { DbClient } from '../db/client'
import type { SiteCssBundle } from '@core/publisher'
import { resolveTemplateChain } from '@core/templates'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import {
  getPublishedDataRowByRoute,
  listPublishedRowRoutes,
} from '../repositories/data/publish'
import { renderPublishedDataRowTemplate } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { snapshotForEntryRoute } from './entryTemplateSnapshot'

export interface DataRowBakeTarget {
  /**
   * The publish version the baked shells must carry — the NEXT version for
   * a full publish (the bake runs before `bumpPublishVersion()`), and
   * likewise for an in-place republish that bumps right after.
   */
  publishVersion: number
  /**
   * Where each route's HTML goes: `writeArtefact` into the inactive slot
   * for a full publish, `updateArtefactInPlace` into the active slot for a
   * republish. The render path is identical either way.
   */
  write: (urlPath: string, html: string) => Promise<void>
}

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
 * Bake every published data-row route through `target.write`. The full
 * publish calls this AFTER its transaction commits (the row list and
 * snapshot reads see the freshly-committed publish) and BEFORE the slot
 * swap; a site plugin activation calls it to refresh the active slot in
 * place.
 *
 * `target.publishVersion` is the version that becomes current at the
 * caller's swap or bump, so baked hole shells are never stamped stale.
 * Passing it to the versioned snapshot memo also pre-warms the cache
 * visitors are about to read.
 */
export async function bakePublishedDataRowArtefacts(
  db: DbClient,
  target: DataRowBakeTarget,
): Promise<DataRowBakeResult> {
  const { publishVersion } = target
  const result: DataRowBakeResult = { baked: 0, cssBundles: [] }

  const routes = await listPublishedRowRoutes(db)
  if (routes.length === 0) return result

  const siteSnapshot = await getLatestSnapshotForVersion(db, publishVersion)
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
    try {
      const row = await getPublishedDataRowByRoute(db, route.tableRouteBase, route.rowSlug)
      if (!row) continue
      const syntheticUrl = new URL(`http://localhost${urlPath}`)
      // Runtime assets come from this table's entry template, not from the
      // arbitrary page the site-wide snapshot happens to name.
      const snapshot = await snapshotForEntryRoute(db, siteSnapshot, route.tableSlug)
      const rendered = await renderPublishedDataRowTemplate(snapshot, row, {
        db,
        url: syntheticUrl,
        publishVersion,
      })
      if (!rendered) continue
      const html = await applyPublishedHtmlPipeline(rendered, db)
      await target.write(urlPath, html)
      result.cssBundles.push(rendered.cssBundle)
      result.baked++
    } catch (err) {
      console.error('[publish:site] failed to bake row artefact for', urlPath, '(falls through to live renderer):', err)
    }
  }

  return result
}
