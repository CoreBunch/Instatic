/** Publishes one locale variant and rebuilds surfaces that depend on visibility. */
import type { DbClient } from '../db/client'
import type { DataRow, DataRowVersion } from '@core/data/schemas'
import type { ScheduledLocalizationRevision } from '@core/localization-schema'
import { buildLocalizedPath, createPublishedRouteInventory, readSnapshotLanguage, LocalizedRouteError } from '@core/localization-routing'
import { resolveTemplateChain } from '@core/templates'
import { getDataRow, getDataTable, getPublishedDataRowById } from '../repositories/data'
import { persistDataRowPublish, readPreviousPublishedRoute } from '../repositories/data/publish'
import { getDefaultLocale, getLocale, getTableLocalization, listLocales } from '../repositories/localization'
import { listPublishedRouteCandidates } from '../repositories/localizationRoutes'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { removeArtefactInPlace } from './staticArtefact'
import { bumpPublishVersion, withPublishLock } from './publishState'
import { runPublishFlush } from './publishFlush'
import { publishDraftSite } from './publishSite'
import { rebakePublishedRoutes } from './rebakePublishedRoutes'

export interface PublishDataRowResult { row: DataRow; version: DataRowVersion }
export interface PublishDataRowOptions { localeId?: string; revision?: ScheduledLocalizationRevision }

export async function publishDataRow(
  db: DbClient, rowId: string, publisherUserId: string | null,
  uploadsDir?: string, options: PublishDataRowOptions = {},
): Promise<PublishDataRowResult> {
  await runPublishFlush()
  const initialRow = await getDataRow(db, rowId, options.localeId)
  if (!initialRow) throw new Error('Content no longer exists')
  if (initialRow.tableId === 'pages') {
    await publishDraftSite(db, publisherUserId, uploadsDir, {
      variants: [{ rowId, localeId: initialRow.localeId }],
      ...(options.revision ? { revision: options.revision } : {}),
    })
    const [publishedRow, version] = await Promise.all([
      getDataRow(db, rowId, initialRow.localeId), getPublishedDataRowById(db, rowId, initialRow.localeId),
    ])
    if (!publishedRow || !version) throw new Error('Published page version is missing')
    return { row: publishedRow, version }
  }
  return withPublishLock(async () => {
    const row = await getDataRow(db, rowId, initialRow.localeId)
    if (!row) throw new Error('Content no longer exists')
    const [table, locale, locales, live] = await Promise.all([
      getDataTable(db, row.tableId), getLocale(db, row.localeId), listLocales(db), listPublishedRouteCandidates(db),
    ])
    if (!table || !locale) throw new Error('Content collection or language no longer exists')
    if (!locale.enabled) throw new LocalizedRouteError(locale.id, 'Enable this language before publishing content.')
    const primary = await getDefaultLocale(db)
    const routeConfig = await getTableLocalization(db, table.id, locale.id)
      ?? await getTableLocalization(db, table.id, primary.id)
    const snapshot = options.revision && !options.revision.siteSnapshotId ? null
      : await getLatestPublishedSiteSnapshot(db, locale.id, options.revision?.siteSnapshotId)
    const routed = table.kind === 'postType' && snapshot
      && resolveTemplateChain(snapshot.site, { kind: 'entry', tableSlug: table.slug }).length > 0
    const path = options.revision && options.revision.publicPath !== undefined ? options.revision.publicPath
      : routed ? buildLocalizedPath(locale, options.revision?.slug ?? row.slug, routeConfig?.routeBase ?? table.routeBase) : null
    createPublishedRouteInventory(locales, [
      ...live.filter((entry) => entry.contentId !== rowId || entry.localeId !== locale.id),
      ...(path ? [{ contentId: rowId, localeId: locale.id, publishedVersionId: 'planned',
        languageCode: snapshot ? readSnapshotLanguage(locale.id, snapshot.site.locales, snapshot.site.settings.language).code : locale.code,
        tableId: table.id, tableSlug: table.slug, availability: 'online' as const, kind: 'row' as const, path }] : []),
    ])
    const result = await persistDataRowPublish(db, rowId, publisherUserId, {
      localeId: locale.id, publicPath: path, siteSnapshotId: snapshot?.siteSnapshotId ?? null,
      revision: options.revision,
    })
    const version = bumpPublishVersion()
    if (uploadsDir) await rebakePublishedRoutes(db, uploadsDir, version)
    return { row: result.row, version: result.version }
  })
}

/** The previous version retains its public path even after retraction or deletion. */
export async function removeDataRowArtefact(
  db: DbClient, uploadsDir: string, rowId: string, options: { localeId?: string } = {},
): Promise<void> {
  const previous = await readPreviousPublishedRoute(db, rowId, options.localeId)
  if (previous) await removeArtefactInPlace(uploadsDir, previous.path)
}
