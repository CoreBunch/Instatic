/**
 * Incremental (per-row) publish orchestrator.
 *
 * Drives one data row through the publish pipeline:
 *
 *   1. `persistDataRowPublish` — one short DB transaction (the data
 *      repository owns all SQL).
 *   2. Layer A — drop the baked pages that loop over the row's table
 *      (`loopArtefacts.ts`), then update the row's own baked artefact in the
 *      ACTIVE slot in place (and prune the old path when the slug changed).
 *   3. Layer B — bump the publish version so the render cache refreshes.
 *
 * Data access lives in `server/repositories/data/publish.ts`; this module
 * owns the sequencing, rendering, and disk artefacts. The dependency
 * direction is one-way: publish → repositories, never back.
 */
import { listProtectedTables } from '../repositories/data/tableAccess'
import type { DbClient } from '../db/client'
import type { DataRow, DataRowVersion } from '@core/data/schemas'
import { normalizeRouteBase, resolveTemplateChain } from '@core/templates'
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
import { snapshotForEntryRoute } from './entryTemplateSnapshot'
import { renderPublishedDataRowTemplate } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import { removeArtefactInPlace, removeArtefactsInPlace, updateArtefactInPlace } from './staticArtefact'
import { removeArtefactsLoopingOverTable } from './loopArtefacts'
import { bumpPublishVersion, getPublishVersion, withPublishLock } from './publishState'
import { runPublishFlush } from './publishFlush'
import { getDataRow } from '../repositories/data'
import { MAIN_SCOPE } from '../branches/scope'
import { publishPageRowLocked } from './publishSite'

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
  // Flush the collab relay before reading the row — a page/component/row doc
  // edited live may still hold un-persisted changes inside the debounce
  // window, and per-row publish must bake exactly what the admins see.
  await runPublishFlush()
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
  const draft = await getDataRow(db, MAIN_SCOPE, rowId)
  if (!draft) throw new Error('data row not found')
  if (draft.tableId === 'pages') return publishPageRowLocked(db, draft, publisherUserId, uploadsDir)

  const { row, version, previousRoute } = await persistDataRowPublish(db, rowId, publisherUserId)

  // Layer A: incremental artefact update outside the transaction.
  // Disk artefacts are derived state — errors are logged but do not fail
  // the publish. The next full publish (publishDraftSite) will rebuild.
  if (uploadsDir) {
    // Pages that list this table were baked with the previous rows. Drop them
    // first so the row's own artefact, written next, is the only fresh file
    // left for a route that lists its own table.
    await removeArtefactsLoopingOverTable(db, uploadsDir, row.tableId).catch((err) => {
      console.error('[publish:row] failed to drop baked pages that loop over table', row.tableId, err)
    })
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
  // Entries of a protected table never go to disk; drop any file left from
  // before the table was protected.
  const protectedBases = (await listProtectedTables(db)).map((table) => table.routeBase)
  if (protectedBases.includes(normalizeRouteBase(tableInfo.tableRouteBase))) {
    await removeArtefactInPlace(uploadsDir, newPath)
    return
  }
  const syntheticUrl = new URL(`http://localhost${newPath}`)
  // Runtime assets come from this table's entry template, not from the
  // arbitrary page the site-wide snapshot happens to name.
  const snapshot = await snapshotForEntryRoute(db, siteSnapshot, tableInfo.tableSlug)
  const rendered = await renderPublishedDataRowTemplate(snapshot, publishedDataRow, {
    db,
    url: syntheticUrl,
    publishVersion,
  })
  if (!rendered) return

  const html = await applyPublishedHtmlPipeline(rendered, db)
  await updateArtefactInPlace(uploadsDir, newPath, html)
}

/**
 * Retract a data row from Layer A after it left public visibility (unpublish,
 * revert-to-draft, soft-delete). Layer A reads the disk slot with no
 * publishVersion awareness, so without this the retracted content stays
 * public (ISS-039):
 *
 *   - the row's own baked artefact is removed. The route is resolved WITHOUT
 *     the `deleted_at is null` filter so it still works after a soft delete;
 *     an unresolved route or a missing file is a no-op.
 *   - when the row was published, the baked pages that loop over its table are
 *     removed too, so no listing keeps a card that links to a 404.
 *
 * Runs under the publish lock so a full publish cannot swap the active slot
 * mid-way. Never call it inside an open DB transaction (see
 * `bumpPublishVersionSerialized`).
 */
export function retractDataRowArtefacts(
  db: DbClient,
  uploadsDir: string,
  row: Pick<DataRow, 'id' | 'tableId' | 'slug'>,
  options: { wasPublished: boolean },
): Promise<void> {
  return retractDataRowArtefactsMany(db, uploadsDir, [{ ...row, wasPublished: options.wasPublished }])
}

/**
 * Batch form of `retractDataRowArtefacts`: one publish-lock hold for the whole
 * batch, and the listing pages of each table are removed once however many of
 * its published rows left.
 */
export function retractDataRowArtefactsMany(
  db: DbClient,
  uploadsDir: string,
  rows: ReadonlyArray<Pick<DataRow, 'id' | 'tableId' | 'slug'> & { wasPublished: boolean }>,
): Promise<void> {
  return withPublishLock(async () => {
    const ownPaths: string[] = []
    for (const row of rows) {
      const routeBase = await getRowTableRouteBase(db, row.id)
      if (routeBase !== null) ownPaths.push(publicDataPath(routeBase, row.slug))
    }
    await removeArtefactsInPlace(uploadsDir, ownPaths)
    const listedTableIds = new Set(rows.filter((row) => row.wasPublished).map((row) => row.tableId))
    for (const tableId of listedTableIds) {
      await removeArtefactsLoopingOverTable(db, uploadsDir, tableId)
    }
  })
}
