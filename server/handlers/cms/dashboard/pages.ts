/**
 * Pages widget reader — point-in-time status counts for the `pages`
 * system table plus a "+N this week" delta of pages published in the
 * trailing 7 days.
 */
import type { DbClient } from '../../../db/client'
import { readPublishedSinceCount, readStatusCounts } from './shared'
import type { PagesStats } from './types'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export async function readPagesStats(db: DbClient): Promise<PagesStats> {
  const sevenDaysAgoIso = new Date(Date.now() - SEVEN_DAYS_MS).toISOString()
  const [counts, delta] = await Promise.all([
    readStatusCounts(db, 'pages'),
    readPublishedSinceCount(db, 'pages', sevenDaysAgoIso),
  ])
  return {
    total: counts.total,
    variants: counts.variants,
    offline: counts.offline,
    published: counts.published,
    drafts: counts.drafts,
    scheduled: counts.scheduled,
    deltaPublishedThisWeek: delta,
  }
}
