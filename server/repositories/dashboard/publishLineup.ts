import type { PublishLineupRow, PublishLineupStats } from '@core/dashboard'
import { pagePublicPath, parsePageTemplate } from '@core/page-tree'
import { isoDateOrNull } from '@core/utils/isoDate'
import type { DataPrincipal } from '../../auth/dataAccess'
import type { DbClient } from '../../db/client'
import { jsonFieldTyped, jsonObjectField } from '../../db/jsonExtract'
import { publicDataPath } from '../data/publish'
import { dashboardContentQuery } from './content'

type LineupRow = {
  id: string
  slug: string
  table_slug: string
  kind: PublishLineupRow['tableKind']
  route_base: string | null
  route_slug: string | null
  template_enabled: boolean | number | null
  template_target_json: unknown
  at: string | Date | null
}

export async function readPublishLineup(db: DbClient, principal: DataPrincipal): Promise<PublishLineupStats> {
  const [scheduled, published, drafts] = await Promise.all([
    fetchSlice(db, principal, 'scheduled', 3),
    fetchSlice(db, principal, 'published', 2),
    fetchSlice(db, principal, 'draft', 2),
  ])
  return { rows: [...scheduled, ...published, ...drafts] }
}

function rowPublicPath(row: LineupRow): string | null {
  if (!row.route_slug) return null
  if (row.kind === 'page') {
    const enabled = row.template_enabled === true || row.template_enabled === 1
    const template = parsePageTemplate({ enabled, target: row.template_target_json })
    return template ? null : pagePublicPath(row.route_slug)
  }
  return row.route_base?.trim() ? publicDataPath(row.route_base, row.route_slug) : null
}

/** Authorize before limiting so hidden rows cannot displace visible rows. */
async function fetchSlice(
  db: DbClient,
  principal: DataPrincipal,
  status: PublishLineupRow['status'],
  limit: number,
): Promise<PublishLineupRow[]> {
  const query = dashboardContentQuery(db, principal)
  const statusParam = query.bind(status)
  const limitParam = query.bind(limit)
  const order = status === 'scheduled' ? 'r.scheduled_publish_at asc'
    : status === 'published' ? 'r.published_at desc' : 'r.updated_at desc'
  const timestamp = status === 'scheduled' ? 'and r.scheduled_publish_at is not null'
    : status === 'published' ? 'and r.published_at is not null' : ''
  const draftTemplate = jsonFieldTyped('draft_cells_json', 'templateEnabled', db.dialect, 'boolean')
  const publishedTemplate = jsonFieldTyped('cells_json', 'templateEnabled', db.dialect, 'boolean')
  const draftTarget = jsonObjectField('draft_cells_json', 'templateTarget', db.dialect)
  const publishedTarget = jsonObjectField('cells_json', 'templateTarget', db.dialect)

  const { rows } = await db.unsafe<LineupRow>(`
    ${query.sql}
    select r.id, r.slug, r.table_slug, r.kind, r.route_base,
           case when r.status = 'published' then v.slug else r.slug end as route_slug,
           case when r.kind = 'page' and r.status = 'published' then ${publishedTemplate.sql}
                when r.kind = 'page' then ${draftTemplate.sql} end as template_enabled,
           case when r.kind = 'page' and r.status = 'published' then ${publishedTarget.sql}
                when r.kind = 'page' then ${draftTarget.sql} end as template_target_json,
           case when r.status = 'scheduled' then r.scheduled_publish_at
                when r.status = 'published' then r.published_at end as at
    from visible_rows r
    left join data_row_versions v on v.id = r.active_version_id and r.status = 'published'
    where r.status = ${statusParam} ${timestamp}
    order by ${order}, r.id asc limit ${limitParam}
  `, query.params)

  return rows.map((row) => ({
    id: row.id,
    tableSlug: row.table_slug,
    tableKind: row.kind,
    slug: row.slug,
    path: rowPublicPath(row),
    status,
    at: isoDateOrNull(row.at),
  }))
}
