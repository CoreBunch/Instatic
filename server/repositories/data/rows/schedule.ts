import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import { ScheduledLocalizationRevisionSchema, type ScheduledLocalizationRevision } from '@core/localization-schema'
import { parseValue } from '@core/utils/typeboxHelpers'
import { isoDate } from '@core/utils/isoDate'
import { getDataRow } from './read'
import { cancelContentLocalizationSchedule, saveContentLocalizationDraft, scheduleContentLocalizationPublish } from '../../localization'

/** Scheduling captures resolved content and keeps any current public version active. */
export async function scheduleDataRowPublish(db: DbClient, rowId: string, whenIso: string, actorUserId: string | null = null, localeId?: string): Promise<DataRow | null> {
  const row = await getDataRow(db, rowId, localeId)
  if (!row) return null
  if (!row.localization) await saveContentLocalizationDraft(db, rowId, row.localeId, { cells: {}, slug: row.slug }, actorUserId)
  await scheduleContentLocalizationPublish(db, rowId, row.localeId, whenIso, { cells: row.cells, slug: row.slug }, actorUserId)
  return getDataRow(db, rowId, row.localeId)
}

export async function cancelScheduledPublish(db: DbClient, rowId: string, actorUserId: string | null = null, localeId?: string): Promise<DataRow | null> {
  const row = await getDataRow(db, rowId, localeId)
  if (!row?.scheduledPublishAt) return null
  await cancelContentLocalizationSchedule(db, rowId, row.localeId, actorUserId)
  return getDataRow(db, rowId, row.localeId)
}

interface DueScheduledRow {
  rowId: string
  tableId: string
  localeId: string
  scheduledPublishAt: string
  scheduledRevision: ScheduledLocalizationRevision
}

export async function listDuePublishSchedules(db: DbClient, nowIso: string, limit: number): Promise<DueScheduledRow[]> {
  const { rows } = await db<{
    row_id: string
    table_id: string
    locale_id: string
    scheduled_publish_at: string | Date
    scheduled_revision_json: unknown
  }>`
    select localizations.row_id, data_rows.table_id, localizations.locale_id,
           localizations.scheduled_publish_at, localizations.scheduled_revision_json
    from data_row_localizations localizations
    join data_rows on data_rows.id = localizations.row_id
    join data_tables on data_tables.id = data_rows.table_id
    join site_locales on site_locales.id = localizations.locale_id
    where localizations.scheduled_publish_at <= ${nowIso}
      and data_rows.deleted_at is null and data_tables.deleted_at is null
      and site_locales.enabled = ${true}
    order by localizations.scheduled_publish_at, localizations.row_id, localizations.locale_id
    limit ${Math.max(1, limit)}
  `
  return rows.map((row) => ({
    rowId: row.row_id,
    tableId: row.table_id,
    localeId: row.locale_id,
    scheduledPublishAt: isoDate(row.scheduled_publish_at),
    scheduledRevision: parseValue(ScheduledLocalizationRevisionSchema, row.scheduled_revision_json),
  }))
}
