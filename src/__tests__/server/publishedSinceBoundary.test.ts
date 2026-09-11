import { describe, test, expect } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { createDataRow } from '../../../server/repositories/data/rows/mutations'
import { getDataRow } from '../../../server/repositories/data/rows/read'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { persistDataRowPublish } from '../../../server/repositories/data/publish'
import { readPublishedSinceCount } from '../../../server/handlers/cms/dashboard/shared'

/**
 * `published_at >= ${sinceIso}` is a string comparison on SQLite. When the
 * publish path stamped `published_at` with SQL `current_timestamp`
 * (`YYYY-MM-DD HH:MM:SS`) and `since` was a bound ISO string, every row
 * published on the boundary day compared *below* the cutoff (`' '` sorts
 * before `'T'`), so the dashboard's "+N this week" delta and the 28-day
 * histogram silently dropped that day. Publishing now binds ISO 8601, so the
 * comparison holds on the boundary day itself.
 */
describe('dashboard published-since window', () => {
  test('counts a row published on the same day as the since cutoff', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await db`insert into users (id, email, email_normalized, display_name, password_hash, role_id)
               values (${'u1'}, ${'a@example.com'}, ${'a@example.com'}, ${'A'}, ${'hash'}, ${'member'})`
      const row = await createDataRow(db, MAIN_SCOPE, { tableId: 'posts', cells: { title: 'Boundary' }, slug: 'boundary' }, 'u1')
      await persistDataRowPublish(db, row.id, 'u1')

      const published = await getDataRow(db, MAIN_SCOPE, row.id)
      const publishedAt = published?.publishedAt
      expect(publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      // Start of the publish day itself: the strictest same-day cutoff.
      const since = `${publishedAt!.slice(0, 10)}T00:00:00.000Z`

      expect(await readPublishedSinceCount(db, 'posts', since)).toBe(1)
    } finally {
      await cleanup()
    }
  })
})
