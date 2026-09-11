/**
 * Publish lineup widget reader — three slices joined by status:
 * upcoming scheduled, recently published, drafts in progress.
 */
import { isoDateOrNull } from '@core/utils/isoDate'
import type { DbClient } from '../../../db/client'
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
export async function readPublishLineup(db: DbClient): Promise<PublishLineupStats> {
  const [scheduled, published, drafts] = await Promise.all([
    fetchSlice(db, 'scheduled', SCHEDULED_LIMIT),
    fetchSlice(db, 'published', PUBLISHED_LIMIT),
    fetchSlice(db, 'draft', DRAFT_LIMIT),
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

/**
 * Fetch one slice of the lineup. The status determines the sort key:
 *   • scheduled → `scheduled_publish_at` asc  (soonest first)
 *   • published → `published_at` desc         (newest first)
 *   • draft     → `updated_at` desc           (most-recently touched)
 *
 * Each query is hand-written rather than parameterising the ORDER BY
 * because tagged-template SQL binding can't safely interpolate column
 * names, and the three queries fit on the screen.
 */
async function fetchSlice(
  db: DbClient,
  status: 'scheduled' | 'published' | 'draft',
  limit: number,
): Promise<LineupRow[]> {
  if (status === 'scheduled') {
    const { rows } = await db<LineupRow>`
      select r.id,
             r.slug,
             r.table_id,
             t.route_base,
             r.scheduled_publish_at,
             r.published_at
      from data_rows r
      join data_tables t on t.id = r.table_id
      where r.branch_id = 'main'
        and r.deleted_at is null
        and r.status = 'scheduled'
        and r.scheduled_publish_at is not null
      order by r.scheduled_publish_at asc
      limit ${limit}
    `
    return rows
  }
  if (status === 'published') {
    const { rows } = await db<LineupRow>`
      select r.id,
             r.slug,
             r.table_id,
             t.route_base,
             r.scheduled_publish_at,
             r.published_at
      from data_rows r
      join data_tables t on t.id = r.table_id
      where r.branch_id = 'main'
        and r.deleted_at is null
        and r.status = 'published'
        and r.published_at is not null
      order by r.published_at desc
      limit ${limit}
    `
    return rows
  }
  // Drafts — most-recently-touched first. We don't list the entire
  // backlog; the widget is a snapshot, not the Content workspace.
  const { rows } = await db<LineupRow>`
    select r.id,
           r.slug,
           r.table_id,
           t.route_base,
           r.scheduled_publish_at,
           r.published_at
    from data_rows r
    join data_tables t on t.id = r.table_id
    where r.branch_id = 'main'
      and r.deleted_at is null
      and r.status = 'draft'
    order by r.updated_at desc
    limit ${limit}
  `
  return rows
}
