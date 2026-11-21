import type { DataPrincipal } from '../../auth/dataAccess'
/** Page counts include only rows the caller may read. */
import type { DbClient } from '../../db/client'
import { dashboardContentQuery } from './content'
import { coerceCount } from './shared'
import type { PagesStats } from './types'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function readPagesStats(
  db: DbClient,
  principal: DataPrincipal,
): Promise<PagesStats> {
  const query = dashboardContentQuery(db, principal)
  const since = query.bind(new Date(Date.now() - SEVEN_DAYS_MS).toISOString())
  const { rows } = await db.unsafe<{ status: string; count: number | string; recent: number | string }>(`
    ${query.sql}
    select status, count(*) as count,
           sum(case when published_at >= ${since} then 1 else 0 end) as recent
    from visible_rows where table_id = 'pages' group by status
  `, query.params)
  const result: PagesStats = { total: 0, published: 0, drafts: 0, scheduled: 0, deltaPublishedThisWeek: 0 }
  for (const row of rows) {
    const count = coerceCount(row.count)
    if (row.status === 'published') {
      result.published = count
      result.deltaPublishedThisWeek = coerceCount(row.recent)
    } else if (row.status === 'draft') result.drafts = count
    else if (row.status === 'scheduled') result.scheduled = count
  }
  result.total = result.published + result.drafts + result.scheduled
  return result
}
