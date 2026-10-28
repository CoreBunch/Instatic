import { afterEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import { getDataRow, listDuePublishSchedules } from '../../../server/repositories/data/rows'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { MAIN_SCOPE } from '../../../server/branches/scope'

async function seedScheduledPostRow(
  db: DbClient,
  input: { rowId: string; slug: string; scheduledAt: string },
): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, scheduled_publish_at)
    values (
      ${input.rowId},
      ${'posts'},
      ${{ title: 'Scheduled post', body: 'Scheduled content' }},
      ${input.slug},
      ${'scheduled'},
      ${input.scheduledAt}
    )
  `
}

describe('publish scheduler', () => {
  const cleanupFns: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanupFns.length) await cleanupFns.pop()?.()
  })

  async function makeDb(): Promise<TestDb> {
    const testDb = await createTestDb()
    cleanupFns.push(testDb.cleanup)
    return testDb
  }

  it('publishes due scheduled post rows as system publishes (PUBLISH-002)', async () => {
    const { db } = await makeDb()
    const rowId = 'scheduled-post-row'
    const scheduledAt = new Date(Date.now() - 60_000).toISOString()
    await seedScheduledPostRow(db, {
      rowId,
      slug: 'scheduled-post',
      scheduledAt,
    })

    await expect(listDuePublishSchedules(db, new Date().toISOString(), 25)).resolves.toHaveLength(1)

    await tickPublishScheduler(db)

    const row = await getDataRow(db, MAIN_SCOPE, rowId)
    expect(row).toMatchObject({
      id: rowId,
      tableId: 'posts',
      slug: 'scheduled-post',
      status: 'published',
      publishedByUserId: null,
      updatedByUserId: null,
      scheduledPublishAt: scheduledAt,
    })
    expect(row?.publishedAt).toBeString()
    await expect(listDuePublishSchedules(db, new Date().toISOString(), 25)).resolves.toHaveLength(0)

    const { rows: dataRows } = await db<{ active_version_id: string | null }>`
      select active_version_id
      from data_rows
      where id = ${rowId}
    `
    expect(dataRows[0]?.active_version_id).toBeString()

    const { rows: versions } = await db<{ row_id: string; slug: string; published_by_user_id: string | null }>`
      select row_id, slug, published_by_user_id
      from data_row_versions
      where row_id = ${rowId}
    `
    expect(versions).toEqual([
      {
        row_id: rowId,
        slug: 'scheduled-post',
        published_by_user_id: null,
      },
    ])
  })
})
