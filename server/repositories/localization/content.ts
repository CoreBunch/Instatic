import {
  ContentLocalizationSchema,
  type ContentLocalization,
  type ContentLocalizationDraftInput,
  type LocalizationAvailability,
  type ScheduledLocalizationRevision,
} from '@core/localization-schema'
import { isoDate, isoDateOrNull } from '@core/utils/isoDate'
import { parseValue } from '@core/utils/typeboxHelpers'
import { placeholder, type DbClient } from '../../db/client'

interface LocalizationRow {
  row_id: string
  locale_id: string
  cells_json: unknown
  slug: string
  availability: string
  active_version_id: string | null
  scheduled_publish_at: string | Date | null
  scheduled_revision_json: unknown
  translation_meta_json: unknown
  seq: number | string | bigint
  created_by_user_id: string | null
  updated_by_user_id: string | null
  published_by_user_id: string | null
  created_at: string | Date
  updated_at: string | Date
  published_at: string | Date | null
}

function mapLocalization(row: LocalizationRow): ContentLocalization {
  return parseValue(ContentLocalizationSchema, {
    rowId: row.row_id,
    localeId: row.locale_id,
    cells: row.cells_json,
    slug: row.slug,
    availability: row.availability,
    activeVersionId: row.active_version_id,
    scheduledPublishAt: isoDateOrNull(row.scheduled_publish_at),
    scheduledRevision: row.scheduled_revision_json,
    translationMeta: row.translation_meta_json,
    seq: Number(row.seq),
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    publishedByUserId: row.published_by_user_id,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    publishedAt: isoDateOrNull(row.published_at),
  })
}

export interface ListContentLocalizationsOptions {
  rowIds?: readonly string[]
  tableId?: string
  localeId?: string
}

export async function listContentLocalizations(
  db: DbClient,
  options: ListContentLocalizationsOptions = {},
): Promise<ContentLocalization[]> {
  if (options.rowIds?.length === 0) return []
  const params: unknown[] = []
  const conditions = ['data_rows.deleted_at is null', 'data_tables.deleted_at is null']
  function bind(value: unknown): string {
    params.push(value)
    return placeholder(db.dialect, params.length)
  }
  if (options.rowIds) {
    conditions.push(`localizations.row_id in (${options.rowIds.map(bind).join(', ')})`)
  }
  if (options.tableId) conditions.push(`data_rows.table_id = ${bind(options.tableId)}`)
  if (options.localeId !== undefined) conditions.push(`localizations.locale_id = ${bind(options.localeId)}`)
  const { rows } = await db.unsafe<LocalizationRow>(`
    select localizations.*
    from data_row_localizations localizations
    join data_rows on data_rows.id = localizations.row_id
    join data_tables on data_tables.id = data_rows.table_id
    where ${conditions.join(' and ')}
    order by localizations.row_id, localizations.locale_id
  `, params)
  return rows.map(mapLocalization)
}

export async function getContentLocalization(
  db: DbClient,
  rowId: string,
  localeId: string,
): Promise<ContentLocalization | null> {
  return (await listContentLocalizations(db, { rowIds: [rowId], localeId }))[0] ?? null
}

/** Writes only the editable variant; an existing public snapshot stays active. */
export async function saveContentLocalizationDraft(
  db: DbClient,
  rowId: string,
  localeId: string,
  input: ContentLocalizationDraftInput,
  actorUserId: string | null = null,
): Promise<ContentLocalization | null> {
  // The dedicated slug is the routing value. Keep an existing editable slug
  // override consistent with it without inventing an absent sparse override.
  const cells = Object.hasOwn(input.cells, 'slug') ? { ...input.cells, slug: input.slug } : input.cells
  const { rows } = await db<{ row_id: string }>`
    insert into data_row_localizations
      (row_id, locale_id, cells_json, slug, translation_meta_json, seq, created_by_user_id, updated_by_user_id)
    select data_rows.id, ${localeId}, ${cells}, ${input.slug}, ${input.translationMeta ?? {}}, 1,
           ${actorUserId}, ${actorUserId}
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.id = ${rowId} and data_rows.deleted_at is null and data_tables.deleted_at is null
      and exists (select 1 from site_locales where id = ${localeId})
    on conflict (row_id, locale_id) do update
      set cells_json = excluded.cells_json,
          slug = excluded.slug,
          translation_meta_json = case when ${input.translationMeta != null}
            then excluded.translation_meta_json else data_row_localizations.translation_meta_json end,
          seq = data_row_localizations.seq + 1,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = current_timestamp
    returning row_id
  `
  return rows[0] ? getContentLocalization(db, rowId, localeId) : null
}

/** Retracting a variant also cancels its scheduled publication; history is retained. */
export async function setContentLocalizationAvailability(
  db: DbClient,
  rowId: string,
  localeId: string,
  availability: LocalizationAvailability,
  actorUserId: string | null = null,
): Promise<ContentLocalization | null> {
  const { rows } = await db<{ row_id: string }>`
    update data_row_localizations
    set availability = ${availability},
        scheduled_publish_at = case when ${availability} = 'offline' then null else scheduled_publish_at end,
        scheduled_revision_json = case when ${availability} = 'offline' then null else scheduled_revision_json end,
        seq = seq + 1, updated_by_user_id = ${actorUserId}, updated_at = current_timestamp
    where row_id = ${rowId} and locale_id = ${localeId}
      and exists (select 1 from data_rows where id = ${rowId} and deleted_at is null)
      and (${availability} = 'offline' or exists (
        select 1 from data_row_versions
        where id = data_row_localizations.active_version_id
          and row_id = ${rowId} and locale_id = ${localeId}
      ))
    returning row_id
  `
  return rows[0] ? getContentLocalization(db, rowId, localeId) : null
}

/** Publish orchestration owns the snapshot insert, artefacts, and cache invalidation. */
export async function setContentLocalizationPublishedVersion(
  db: DbClient,
  rowId: string,
  localeId: string,
  versionId: string,
  publisherUserId: string | null = null,
): Promise<ContentLocalization | null> {
  const { rows } = await db<{ row_id: string }>`
    update data_row_localizations
    set availability = 'online', active_version_id = ${versionId},
        published_by_user_id = ${publisherUserId}, published_at = current_timestamp,
        scheduled_publish_at = null, scheduled_revision_json = null,
        seq = seq + 1, updated_by_user_id = ${publisherUserId}, updated_at = current_timestamp
    where row_id = ${rowId} and locale_id = ${localeId}
      and exists (select 1 from data_rows where id = ${rowId} and deleted_at is null)
      and exists (select 1 from data_row_versions
        where id = ${versionId} and row_id = ${rowId} and locale_id = ${localeId})
    returning row_id
  `
  return rows[0] ? getContentLocalization(db, rowId, localeId) : null
}

/** Scheduling freezes resolved cells while leaving the current live version untouched. */
export async function scheduleContentLocalizationPublish(
  db: DbClient,
  rowId: string,
  localeId: string,
  whenIso: string,
  revision: ScheduledLocalizationRevision,
  actorUserId: string | null = null,
): Promise<ContentLocalization | null> {
  const { rows } = await db<{ row_id: string }>`
    update data_row_localizations
    set scheduled_publish_at = ${whenIso}, scheduled_revision_json = ${revision},
        seq = seq + 1, updated_by_user_id = ${actorUserId}, updated_at = current_timestamp
    where row_id = ${rowId} and locale_id = ${localeId}
      and exists (select 1 from data_rows where id = ${rowId} and deleted_at is null)
    returning row_id
  `
  return rows[0] ? getContentLocalization(db, rowId, localeId) : null
}

export async function cancelContentLocalizationSchedule(
  db: DbClient,
  rowId: string,
  localeId: string,
  actorUserId: string | null = null,
): Promise<ContentLocalization | null> {
  const { rows } = await db<{ row_id: string }>`
    update data_row_localizations
    set scheduled_publish_at = null, scheduled_revision_json = null,
        seq = seq + 1, updated_by_user_id = ${actorUserId}, updated_at = current_timestamp
    where row_id = ${rowId} and locale_id = ${localeId}
      and exists (select 1 from data_rows where id = ${rowId} and deleted_at is null)
    returning row_id
  `
  return rows[0] ? getContentLocalization(db, rowId, localeId) : null
}

export async function listDueContentLocalizationSchedules(
  db: DbClient,
  nowIso: string,
): Promise<ContentLocalization[]> {
  const { rows } = await db<LocalizationRow>`
    select localizations.* from data_row_localizations localizations
    join data_rows on data_rows.id = localizations.row_id
    join data_tables on data_tables.id = data_rows.table_id
    join site_locales on site_locales.id = localizations.locale_id
    where localizations.scheduled_publish_at <= ${nowIso}
      and data_rows.deleted_at is null and data_tables.deleted_at is null
      and site_locales.enabled = ${true}
    order by localizations.scheduled_publish_at, localizations.row_id, localizations.locale_id
  `
  return rows.map(mapLocalization)
}
