import type { DataPrincipal } from '../../auth/dataAccess'
/**
 * Publish lineup widget reader — three slices joined by status:
 * upcoming scheduled, recently published, drafts in progress.
 */
import { isoDateOrNull } from '@core/utils/isoDate'
import type { DbClient } from '../../db/client'
import { dashboardContentQuery } from './content'
import { buildRowPath } from './shared'
import type { PublishLineupRow, PublishLineupStats } from './types'

const SCHEDULED_LIMIT = 3
const PUBLISHED_LIMIT = 2
const DRAFT_LIMIT = 2

type LineupRow = {
  id: string
  slug: string
  table_id: string
  route_base: string | null
  scheduled_publish_at: string | Date | null
  published_at: string | Date | null
}

/**
 * Pull the rows that fill the dashboard "Publish lineup" widget.
 *
 *   • Up to 3 upcoming scheduled rows, soonest-first
 *   • Up to 2 recently-published rows, newest-first
 *   • Up to 2 drafts, most-recently-touched first
 *
 * Joined to `data_tables` so we can render the row's public path
 * (`route_base + slug`) — matches what the user sees in the editor.
 * Three separate queries (not one UNION) because:
 *   1. ANSI SQL UNION with mixed ORDER BY is dialect-painful, and
 *   2. The three slices have different sort keys, which a UNION would
 *      force into a single composite key.
 *
 * Combined and ordered client-side: scheduled rows (chronological,
 * soonest first) → published rows (newest first) → drafts. Same order
 * the original mocked widget used so the visual rhythm is preserved.
 */
export async function readPublishLineup(db: DbClient, principal: DataPrincipal): Promise<PublishLineupStats> {
  const [scheduled, published, drafts] = await Promise.all([
    fetchSlice(db, principal, 'scheduled', SCHEDULED_LIMIT),
    fetchSlice(db, principal, 'published', PUBLISHED_LIMIT),
    fetchSlice(db, principal, 'draft', DRAFT_LIMIT),
  ])

  const rows: PublishLineupRow[] = [
    ...scheduled.map((r): PublishLineupRow => ({
      id: r.id,
      path: buildRowPath(r.route_base, r.table_id, r.slug),
      status: 'scheduled',
      at: isoDateOrNull(r.scheduled_publish_at),
    })),
    ...published.map((r): PublishLineupRow => ({
      id: r.id,
      path: buildRowPath(r.route_base, r.table_id, r.slug),
      status: 'published',
      at: isoDateOrNull(r.published_at),
    })),
    ...drafts.map((r): PublishLineupRow => ({
      id: r.id,
      path: buildRowPath(r.route_base, r.table_id, r.slug),
      status: 'draft',
      at: null,
    })),
  ]

  return { rows }
}

/** Authorize before limiting so hidden rows cannot displace visible rows. */
async function fetchSlice(
  db: DbClient,
  principal: DataPrincipal,
  status: 'scheduled' | 'published' | 'draft',
  limit: number,
): Promise<LineupRow[]> {
  const query = dashboardContentQuery(db, principal)
  const statusParam = query.bind(status)
  const limitParam = query.bind(limit)
  const order = status === 'scheduled' ? 'scheduled_publish_at asc'
    : status === 'published' ? 'published_at desc' : 'updated_at desc'
  const timestamp = status === 'scheduled' ? 'and scheduled_publish_at is not null'
    : status === 'published' ? 'and published_at is not null' : ''
  const { rows } = await db.unsafe<LineupRow>(`
    ${query.sql}
    select id, slug, table_id, route_base, scheduled_publish_at, published_at
    from visible_rows where status = ${statusParam} ${timestamp}
    order by ${order}, id asc limit ${limitParam}
  `, query.params)
  return rows
}
