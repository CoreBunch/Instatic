import type { DataPrincipal } from '../../auth/dataAccess'
/** Post totals and timezone-aware histogram share the direct-read visibility policy. */
import type { DbClient } from '../../db/client'
import { localDayKeyFactory } from '../../time'
import { dashboardContentQuery } from './content'
import { coerceCount } from './shared'
import type { PostsStats } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const HISTOGRAM_DAYS = 28

export async function readPostsStats(
  db: DbClient,
  principal: DataPrincipal,
  timeZone: string,
): Promise<PostsStats> {
  const dayKeyOf = localDayKeyFactory(timeZone)
  const query = dashboardContentQuery(db, principal)
  const histogramQuery = dashboardContentQuery(db, principal)
  const since = histogramQuery.bind(new Date(Date.now() - HISTOGRAM_DAYS * DAY_MS).toISOString())
  const [counts, published] = await Promise.all([
    db.unsafe<{ total: number | string; scheduled: number | string; categories: number | string }>(`
      ${query.sql}
      select count(*) as total,
             sum(case when status = 'scheduled' then 1 else 0 end) as scheduled,
             (select count(*) from visible_tables where kind = 'postType') as categories
      from visible_rows where kind = 'postType' and status in ('draft', 'published', 'scheduled')
    `, query.params),
    db.unsafe<{ published_at: string | Date }>(`
      ${histogramQuery.sql}
      select published_at from visible_rows
      where kind = 'postType' and status = 'published' and published_at >= ${since}
    `, histogramQuery.params),
  ])
  const histogram = new Map<string, number>()
  for (const row of published.rows) {
    const day = dayKeyOf(row.published_at)
    histogram.set(day, (histogram.get(day) ?? 0) + 1)
  }
  const daily28 = Array.from({ length: HISTOGRAM_DAYS }, (_, i) => {
    const day = new Date(Date.now() - (HISTOGRAM_DAYS - 1 - i) * DAY_MS)
    return histogram.get(dayKeyOf(day)) ?? 0
  })
  return {
    total: coerceCount(counts.rows[0]?.total),
    categories: coerceCount(counts.rows[0]?.categories),
    scheduled: coerceCount(counts.rows[0]?.scheduled),
    daily28,
  }
}
