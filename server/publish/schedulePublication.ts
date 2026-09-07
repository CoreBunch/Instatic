/** Captures content, route and design dependencies at the time a schedule is set. */
import type { DataRow } from '@core/data/schemas'
import type { ScheduledLocalizationRevision } from '@core/localization-schema'
import { buildLocalizedPath } from '@core/localization-routing'
import { isTemplatePage, resolveTemplateChain } from '@core/templates'
import type { DbClient } from '../db/client'
import { getDataRow, getDataTable } from '../repositories/data'
import { getDraftSiteDocument, getLatestPublishedSiteSnapshot, saveSiteDocumentSnapshot } from '../repositories/publish'
import { getDefaultLocale, getLocale, getTableLocalization, saveContentLocalizationDraft, scheduleContentLocalizationPublish } from '../repositories/localization'
import { runPublishFlush } from './publishFlush'
import { withPublishLock } from './publishState'

export async function scheduleLocalizedDataRowPublish(
  db: DbClient, rowId: string, whenIso: string, actorUserId: string | null = null, localeId?: string,
): Promise<DataRow | null> {
  await runPublishFlush()
  return withPublishLock(async () => {
    const row = await getDataRow(db, rowId, localeId)
    if (!row) return null
    const [locale, table] = await Promise.all([getLocale(db, row.localeId), getDataTable(db, row.tableId)])
    if (!locale || !table) return null
    const revision: ScheduledLocalizationRevision = { cells: row.cells, slug: row.slug }
    if (row.tableId === 'pages') {
      const site = await getDraftSiteDocument(db, { localeId: locale.id })
      const page = site?.pages.find((entry) => entry.id === rowId)
      if (!site || !page) return null
      revision.siteSnapshotId = await saveSiteDocumentSnapshot(db, site)
      revision.publicPath = isTemplatePage(page) ? null : buildLocalizedPath(locale, row.slug)
    } else {
      const snapshot = await getLatestPublishedSiteSnapshot(db, locale.id)
      const primary = await getDefaultLocale(db)
      const config = await getTableLocalization(db, row.tableId, locale.id)
        ?? await getTableLocalization(db, row.tableId, primary.id)
      if (snapshot?.siteSnapshotId) revision.siteSnapshotId = snapshot.siteSnapshotId
      revision.publicPath = table.kind === 'postType' && snapshot
        && resolveTemplateChain(snapshot.site, { kind: 'entry', tableSlug: table.slug }).length > 0
        ? buildLocalizedPath(locale, row.slug, config?.routeBase ?? table.routeBase) : null
    }
    if (!row.localization) await saveContentLocalizationDraft(db, rowId, locale.id, { cells: {}, slug: row.slug }, actorUserId)
    await scheduleContentLocalizationPublish(db, rowId, locale.id, whenIso, revision, actorUserId)
    return getDataRow(db, rowId, locale.id)
  })
}
