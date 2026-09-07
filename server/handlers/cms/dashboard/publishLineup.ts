/** Independent language schedules, frozen releases, and recent authoring drafts. */
import { isoDateOrNull } from '@core/utils/isoDate'
import { ScheduledLocalizationRevisionSchema } from '@core/localization-schema'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { DataRow } from '@core/data/schemas'
import { jsonField } from '../../../db/jsonExtract'
import { placeholder, type DbClient } from '../../../db/client'
import { getDataRowMany, listDataTables } from '../../../repositories/data'
import { getDefaultLocale, listLocales, listTableLocalizations } from '../../../repositories/localization'
import { draftContentPath } from './shared'
import type { PublishLineupRow, PublishLineupStats } from './types'

type SliceRow = {
  row_id: string
  locale_id: string
  public_path: string | null
  scheduled_revision_json: unknown
  scheduled_publish_at: string | Date | null
  published_at: string | Date | null
}

export async function readPublishLineup(db: DbClient): Promise<PublishLineupStats> {
  const slices: Array<{ status: PublishLineupRow['status']; limit: number }> = [
    { status: 'scheduled', limit: 3 }, { status: 'published', limit: 2 },
    { status: 'draft', limit: 2 }, { status: 'offline', limit: 2 },
  ]
  const [locales, source, tables, paths, selected] = await Promise.all([
    listLocales(db), getDefaultLocale(db), listDataTables(db), listTableLocalizations(db),
    Promise.all(slices.map(async ({ status, limit }) => (await fetchSlice(db, status, limit)).map((row) => ({ ...row, status })))),
  ])
  const candidates = selected.flat()
  const resolved = new Map<string, DataRow>()
  await Promise.all(locales.map(async (locale) => {
    const ids = [...new Set(candidates.filter((row) => row.locale_id === locale.id).map((row) => row.row_id))]
    for (const row of await getDataRowMany(db, ids, locale.id)) resolved.set(`${row.id}:${locale.id}`, row)
  }))
  const rows: PublishLineupRow[] = []
  for (const candidate of candidates) {
    const row = resolved.get(`${candidate.row_id}:${candidate.locale_id}`)
    const locale = locales.find((entry) => entry.id === candidate.locale_id)
    const table = tables.find((entry) => entry.id === row?.tableId)
    if (!row || !locale || !table) continue
    const routeBase = paths.find((entry) => entry.tableId === table.id && entry.localeId === locale.id)?.routeBase
      ?? paths.find((entry) => entry.tableId === table.id && entry.localeId === source.id)?.routeBase
    const draftPath = draftContentPath(locale, row, table, routeBase)
    const revision = candidate.scheduled_revision_json === null ? null : parseValue(ScheduledLocalizationRevisionSchema, candidate.scheduled_revision_json)
    const path = candidate.status === 'published' ? candidate.public_path
      : candidate.status === 'scheduled' ? (revision?.publicPath ?? (revision ? draftContentPath(locale, revision, table, routeBase) : draftPath))
      : draftPath
    rows.push({
      id: row.id, localeId: locale.id, localeCode: locale.code, localeEnabled: locale.enabled,
      title: String(row.cells[table.primaryFieldId] ?? (row.slug || row.id)), path, status: candidate.status,
      at: candidate.status === 'scheduled' ? isoDateOrNull(candidate.scheduled_publish_at)
        : candidate.status === 'published' ? isoDateOrNull(candidate.published_at) : null,
    })
  }
  return { rows }
}

async function fetchSlice(db: DbClient, status: PublishLineupRow['status'], limit: number): Promise<SliceRow[]> {
  const live = "l.availability = 'online' and v.id is not null and sl.enabled = true"
  const conditions = {
    scheduled: 'l.scheduled_publish_at is not null',
    published: `${live} and v.public_path is not null`,
    draft: 'l.active_version_id is null and l.scheduled_publish_at is null',
    offline: "l.active_version_id is not null and l.scheduled_publish_at is null and (l.availability = 'offline' or sl.enabled = false)",
  }
  const order = { scheduled: 'l.scheduled_publish_at asc', published: 'v.published_at desc', draft: 'l.updated_at desc', offline: 'l.updated_at desc' }
  const template = jsonField('shared_cells_json', 'templateEnabled', db.dialect).sql
  const { rows } = await db.unsafe<SliceRow>(`
    with logical as (select id, table_id, cells_json as shared_cells_json from data_rows where deleted_at is null)
    select l.row_id, l.locale_id, v.public_path, l.scheduled_revision_json, l.scheduled_publish_at, v.published_at
    from data_row_localizations l
    join logical r on r.id = l.row_id
    join data_tables t on t.id = r.table_id and t.deleted_at is null
    join site_locales sl on sl.id = l.locale_id
    left join data_row_versions v on v.id = l.active_version_id and v.row_id = l.row_id and v.locale_id = l.locale_id
    where t.kind in ('page', 'postType') and coalesce(cast(${template} as text), '') not in ('true', '1')
      and ${conditions[status]}
    order by ${order[status]}, l.row_id, l.locale_id limit ${placeholder(db.dialect, 1)}
  `, [limit])
  return rows
}
