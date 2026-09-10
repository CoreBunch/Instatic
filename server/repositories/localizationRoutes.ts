import { PublishedRouteCandidateSchema, readSnapshotLanguage, type PublishedRouteCandidate } from '@core/localization-routing'
import { isoDate } from '@core/utils/isoDate'
import { parseValue } from '@core/utils/typeboxHelpers'
import { placeholder, type DbClient } from '../db/client'
import { jsonField } from '../db/jsonExtract'
import { LocaleSchema } from '@core/localization-schema'
import { Type } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'

interface PublishedRouteRow {
  row_id: string
  locale_id: string
  version_id: string
  site_snapshot_id: string | null
  table_id: string
  table_slug: string
  table_kind: string
  public_path: string | null
  published_at: string | Date
  slug: string
  title: string | null
  locales_json: unknown
  settings_json: unknown
}

const SnapshotSettingsSchema = Type.Object({ language: Type.Optional(Type.String()) })

/**
 * Public routing reads the selected locale version, never draft slugs/cells or
 * the row-wide status. The three-column version join prevents a localization
 * from exposing a version belonging to another row or language.
 *
 * A page version without a public path is a published template dependency.
 * Collection items without a route remain usable content, not guessed URLs.
 */
export async function listPublishedRouteCandidates(db: DbClient): Promise<PublishedRouteCandidate[]> {
  const titleExpr = jsonField('cells_json', 'title', db.dialect)
  const localesExpr = jsonField('site_json', 'locales', db.dialect)
  const settingsExpr = jsonField('site_json', 'settings', db.dialect)
  const { rows } = await db.unsafe<PublishedRouteRow>(`
    select localizations.row_id,
           localizations.locale_id,
           versions.id as version_id,
           versions.site_snapshot_id,
           tables.id as table_id,
           tables.slug as table_slug,
           tables.kind as table_kind,
           versions.public_path,
           versions.published_at, versions.slug,
           (select ${titleExpr.sql} from data_row_versions where id = versions.id) as title,
           (select ${localesExpr.sql} from site_snapshots where id = versions.site_snapshot_id) as locales_json,
           (select ${settingsExpr.sql} from site_snapshots where id = versions.site_snapshot_id) as settings_json
    from data_row_localizations localizations
    join data_row_versions versions
      on versions.id = localizations.active_version_id
     and versions.row_id = localizations.row_id
     and versions.locale_id = localizations.locale_id
    join data_rows rows on rows.id = localizations.row_id
    join data_tables tables on tables.id = rows.table_id
    join site_locales locales on locales.id = localizations.locale_id
    where localizations.availability = 'online'
      and locales.enabled = ${placeholder(db.dialect, 1)}
      and rows.deleted_at is null
      and tables.deleted_at is null
      and tables.kind in ('page', 'postType')
      and (tables.kind = 'page' or versions.public_path is not null)
    order by rows.created_at asc, rows.id asc, locales.created_at asc, locales.id asc
  `, [true])
  return rows.map((row) => {
    let rawLocales = row.locales_json
    if (typeof rawLocales === 'string') {
      const parsed = safeParseJson(rawLocales, Type.Array(LocaleSchema))
      if (!parsed.ok) throw parsed.error
      rawLocales = parsed.value
    }
    const frozenLocales = rawLocales == null ? [] : parseValue(Type.Array(LocaleSchema), rawLocales)
    let rawSettings = row.settings_json
    if (typeof rawSettings === 'string') {
      const parsed = safeParseJson(rawSettings, SnapshotSettingsSchema)
      if (!parsed.ok) throw parsed.error
      rawSettings = parsed.value
    }
    const settings = parseValue(SnapshotSettingsSchema, rawSettings ?? {})
    const language = readSnapshotLanguage(row.locale_id, frozenLocales, settings.language)
    return parseValue(PublishedRouteCandidateSchema, {
    contentId: row.row_id,
    localeId: row.locale_id,
    publishedVersionId: row.version_id,
    ...(row.site_snapshot_id ? { siteSnapshotId: row.site_snapshot_id } : {}),
    tableId: row.table_id,
    tableSlug: row.table_slug,
    kind: row.table_kind === 'page' ? (row.public_path === null ? 'template' : 'page') : 'row',
    ...(row.public_path !== null ? { path: row.public_path } : {}),
    availability: 'online',
    publishedAt: isoDate(row.published_at),
    slug: row.slug,
    ...(row.title !== null ? { title: row.title } : {}),
    languageCode: language.code, direction: language.direction,
    })
  })
}
