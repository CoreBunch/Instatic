/**
 * Incremental (per-row) publish orchestrator.
 *
 * Drives one data row through the publish pipeline:
 *
 *   1. `persistDataRowPublish` — one short DB transaction (the data
 *      repository owns all SQL).
 *   2. Layer A — update the row's baked artefact in the ACTIVE slot in
 *      place (and prune the old path when the slug changed).
 *   3. Layer B — bump the publish version so the render cache refreshes.
 *
 * Data access lives in `server/repositories/data/publish.ts`; this module
 * owns the sequencing, rendering, and disk artefacts. The dependency
 * direction is one-way: publish → repositories, never back.
 */
import type { DbClient } from '../db/client'
import type { DataRow, DataRowVersion } from '@core/data/schemas'
import { resolveTemplateChain } from '@core/templates'
import {
  getPublishedDataRowByRoute,
  getRowTableRouteBase,
  getRowTableRouteInfo,
  persistDataRowPublish,
  previousRouteChanged,
  publicDataPath,
  type PreviousPublishedRoute,
} from '../repositories/data/publish'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { renderPublishedDataRowTemplate } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import { removeArtefactInPlace, updateArtefactInPlace } from './staticArtefact'
import { bumpPublishVersion, getPublishVersion, withPublishLock } from './publishState'

export interface PublishDataRowResult {
  row: DataRow
  version: DataRowVersion
}

export async function publishDataRow(
  db: DbClient,
  rowId: string,
  /**
   * The user attributed as the publisher. `null` is allowed for system
   * actors that have no user context — e.g. the scheduled-publish tick
   * (`server/publish/publishScheduler.ts`).
   */
  publisherUserId: string | null,
  uploadsDir?: string,
): Promise<PublishDataRowResult> {
  // Serialize against every other publish so the version read→bake→bump window
  // can't interleave and mis-stamp baked hole shells (ISS-038).
  return withPublishLock(() => publishDataRowLocked(db, rowId, publisherUserId, uploadsDir))
}

async function publishDataRowLocked(
  db: DbClient,
  rowId: string,
  publisherUserId: string | null,
  uploadsDir?: string,
): Promise<PublishDataRowResult> {
  const { row, version, previousRoute } = await persistDataRowPublish(db, rowId, publisherUserId)

  // Layer A: incremental artefact update outside the transaction.
  // Disk artefacts are derived state — errors are logged but do not fail
  // the publish. The next full publish (publishDraftSite) will rebuild.
  if (uploadsDir) {
    // Bake with the NEXT publish version — `bumpPublishVersion()` below is the
    // synchronous statement right after this await resolves, so a hole-shell
    // baked here carries the version that becomes current with no gap.
    const nextPublishVersion = getPublishVersion() + 1
    await writeDataRowArtefact(db, uploadsDir, row, previousRoute, nextPublishVersion).catch((err) => {
      console.error('[publish:row] static artefact write failed (live renderer remains active):', err)
    })
  }

  // Layer B: invalidate the in-memory render cache so the next visitor request
  // re-renders against the freshly committed row version.
  bumpPublishVersion()

  return { row, version }
}

/**
 * After a successful `persistDataRowPublish` transaction, write (or remove)
 * the disk artefact for the row's entry-template page.
 *
 * The artefact is baked whether or not the template is fully static: a static
 * template bakes a complete document; a template with dynamic nodes bakes its
 * static SHELL with `<instatic-hole>` placeholders (the hole runtime hydrates each
 * fragment from `/_instatic/hole/`). Either way HTML + CSS + JS come from disk.
 *
 * Steps:
 *   1. Remove the old artefact if the slug changed (old URL no longer valid).
 *   2. Look up the table route info and site snapshot.
 *   3. Render through the template (stamping `publishVersion`) and write the
 *      artefact into the active slot.
 */
async function writeDataRowArtefact(
  db: DbClient,
  uploadsDir: string,
  publishedRow: DataRow,
  previousRoute: PreviousPublishedRoute | null,
  publishVersion: number,
): Promise<void> {
  const tableInfo = await getRowTableRouteInfo(db, publishedRow.id)
  if (!tableInfo) return

  // Remove old artefact when the slug changed (old URL is now stale).
  if (previousRoute && previousRouteChanged(previousRoute, publishedRow.slug)) {
    const oldPath = publicDataPath(previousRoute.routeBase, previousRoute.slug)
    await removeArtefactInPlace(uploadsDir, oldPath).catch((err) => {
      console.error('[publish:row] failed to remove stale artefact at', oldPath, err)
    })
  }

  // Resolve the full template chain for this row's table (everywhere layout +
  // entry template). No chain → no entry route to bake.
  const siteSnapshot = await getLatestPublishedSiteSnapshot(db)
  if (!siteSnapshot) return

  const chain = resolveTemplateChain(siteSnapshot.site, { kind: 'entry', tableSlug: tableInfo.tableSlug })
  if (chain.length === 0) return

  // Fetch the full PublishedDataRow (needed for templateContext + media path).
  const publishedDataRow = await getPublishedDataRowByRoute(db, tableInfo.tableRouteBase, publishedRow.slug)
  if (!publishedDataRow) return

  const newPath = publicDataPath(tableInfo.tableRouteBase, publishedRow.slug)
  const syntheticUrl = new URL(`http://localhost${newPath}`)
  const rendered = await renderPublishedDataRowTemplate(siteSnapshot, publishedDataRow, {
    db,
    url: syntheticUrl,
    publishVersion,
  })
  if (!rendered) return

  const html = await applyPublishedHtmlPipeline(rendered, db)
  await updateArtefactInPlace(uploadsDir, newPath, html)
}

/**
 * Remove a data row's baked Layer-A artefact from the active slot. Called when
 * a row leaves public visibility (unpublish, revert-to-draft, soft-delete) so
 * the static file stops being served — Layer A reads the disk slot with no
 * publishVersion awareness, so without this a retracted row stays public
 * (ISS-039). The route is resolved WITHOUT the `deleted_at is null` filter so
 * it still works after a soft delete. Best-effort: unresolved route or missing
 * file is a no-op (removeArtefactInPlace never throws on a missing file).
 */
export async function removeDataRowArtefact(
  db: DbClient,
  uploadsDir: string,
  rowId: string,
  slug: string,
): Promise<void> {
  const routeBase = await getRowTableRouteBase(db, rowId)
  if (routeBase === null) return
  await removeArtefactInPlace(uploadsDir, publicDataPath(routeBase, slug))
}
