import { afterEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { tickPublishScheduler } from '../../../server/publish/publishScheduler'
import { getDataRow, listDuePublishSchedules } from '../../../server/repositories/data/rows'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { seedPublishingSite } from '../helpers/publishingTestDb'
import { makeSite, makePage } from '../publisher/helpers'
import { scheduleLocalizedDataRowPublish } from '../../../server/publish/schedulePublication'

async function seedScheduledPageRow(
  db: DbClient,
  input: { rowId: string; slug: string; scheduledAt: string },
): Promise<void> {
  const page = makePage({ root: { moduleId: 'base.container' } })
  page.id = input.rowId
  page.slug = input.slug
  page.title = 'Scheduled page'
  await seedPublishingSite(db, makeSite({ pages: [page] }))
  await scheduleLocalizedDataRowPublish(db, input.rowId, input.scheduledAt)

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

  it('publishes due scheduled page rows as system publishes (PUBLISH-002)', async () => {
    const { db } = await makeDb()
    const rowId = 'scheduled-page-row'
    const scheduledAt = new Date(Date.now() - 60_000).toISOString()
    await seedScheduledPageRow(db, {
      rowId,
      slug: 'scheduled-page',
      scheduledAt,
    })

    await expect(listDuePublishSchedules(db, new Date().toISOString(), 25)).resolves.toHaveLength(1)

    await tickPublishScheduler(db)

    const row = await getDataRow(db, rowId)
    expect(row).toMatchObject({
      id: rowId,
      tableId: 'pages',
      slug: 'scheduled-page',
      status: 'published',
      publishedByUserId: null,
      updatedByUserId: null,
      scheduledPublishAt: null,
    })
    expect(row?.publishedAt).toBeString()
    await expect(listDuePublishSchedules(db, new Date().toISOString(), 25)).resolves.toHaveLength(0)

    const { rows: dataRows } = await db<{ active_version_id: string | null }>`
      select active_version_id
      from data_row_localizations
      where row_id = ${rowId} and locale_id = 'default'
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
        slug: 'scheduled-page',
        published_by_user_id: null,
      },
    ])
  })
})
