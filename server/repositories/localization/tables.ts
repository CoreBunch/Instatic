import { TableLocalizationSchema, type TableLocalization } from '@core/localization-schema'
import { LocalizedRouteError, normalizePublishedPath } from '@core/localization-routing'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { LocalizationError } from './errors'

interface TableLocalizationRow {
  table_id: string
  locale_id: string
  route_base: string
}

function mapTableLocalization(row: TableLocalizationRow): TableLocalization {
  return parseValue(TableLocalizationSchema, { tableId: row.table_id, localeId: row.locale_id, routeBase: row.route_base })
}

export async function listTableLocalizations(db: DbClient, tableId?: string): Promise<TableLocalization[]> {
  const { rows } = tableId === undefined
    ? await db<TableLocalizationRow>`select table_id, locale_id, route_base from data_table_localizations order by table_id, locale_id`
    : await db<TableLocalizationRow>`select table_id, locale_id, route_base from data_table_localizations where table_id = ${tableId} order by locale_id`
  return rows.map(mapTableLocalization)
}

/** Returns the stored override; absent secondary routes inherit the default at resolution time. */
export async function getTableLocalization(db: DbClient, tableId: string, localeId: string): Promise<TableLocalization | null> {
  const { rows } = await db<TableLocalizationRow>`
    select table_id, locale_id, route_base from data_table_localizations
    where table_id = ${tableId} and locale_id = ${localeId}
  `
  return rows[0] ? mapTableLocalization(rows[0]) : null
}

export async function saveTableLocalization(db: DbClient, tableId: string, localeId: string, routeBase: string): Promise<TableLocalization | null> {
  const raw = routeBase.trim()
  if (raw !== '' && !raw.startsWith('/')) throw new LocalizationError('Use an absolute route path', 'routeBase')
  let value: string
  try {
    value = raw === '' ? '' : normalizePublishedPath(raw)
  } catch (err) {
    if (err instanceof LocalizedRouteError) throw new LocalizationError(err.message, 'routeBase', { cause: err })
    throw err
  }
  const { rows } = await db<TableLocalizationRow>`
    insert into data_table_localizations (table_id, locale_id, route_base)
    select id, ${localeId}, ${value} from data_tables
    where id = ${tableId} and deleted_at is null
      and exists (select 1 from site_locales where id = ${localeId})
    on conflict (table_id, locale_id) do update set route_base = excluded.route_base
    returning table_id, locale_id, route_base
  `
  return rows[0] ? mapTableLocalization(rows[0]) : null
}
