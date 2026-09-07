import { afterEach, describe, expect, it } from 'bun:test'
import { parseValue } from '@core/utils/typeboxHelpers'
import { DashboardPagesStatsSchema, DashboardPublishLineupStatsSchema } from '@core/dashboard'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { createDataRow, saveDataRowDraft } from '../../../../repositories/data'
import { createAuditEvent } from '../../../../repositories/audit'
import { createLocale, saveTableLocalization, scheduleContentLocalizationPublish, setContentLocalizationPublishedVersion, updateLocale } from '../../../../repositories/localization'
import { readPagesStats } from '../pages'
import { readPostsStats } from '../posts'
import { readPublishLineup } from '../publishLineup'
import { readRecentActivity } from '../activity'

const clients: DbClient[] = []
afterEach(async () => { for (const db of clients.splice(0)) await db.close() })
async function fixture() {
  const db = createSqliteClient(':memory:'); clients.push(db)
  await runMigrations(db, sqliteMigrations)
  const de = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', direction: 'ltr', enabled: true })
  return { db, de }
}
async function release(db: DbClient, rowId: string, localeId: string, number: number, path: string) {
  const id = `${rowId}-${number}`
  await db`insert into data_row_versions (id, row_id, locale_id, version_number, cells_json, slug, public_path) values (${id}, ${rowId}, ${localeId}, ${number}, ${{ title: 'Frozen' }}, 'frozen', ${path})`
  await setContentLocalizationPublishedVersion(db, rowId, localeId, id)
}

describe('localized dashboard read models', () => {
  it('counts logical pages separately from authored language states and independent schedules', async () => {
    const { db, de } = await fixture()
    const page = await createDataRow(db, { tableId: 'pages', cells: { title: 'Home', slug: 'index' }, slug: 'index' })
    await createDataRow(db, { tableId: 'pages', cells: { title: 'Draft', slug: 'draft' }, slug: 'draft' })
    await saveDataRowDraft(db, page.id, { cells: { title: 'Start', slug: 'index' }, slug: 'index', localeId: de.id })
    await release(db, page.id, 'default', 1, '/')
    await release(db, page.id, de.id, 2, '/de')
    await scheduleContentLocalizationPublish(db, page.id, de.id, '2026-12-01T00:00:00.000Z', { cells: { title: 'Scheduled' }, slug: 'later', publicPath: '/de/later' })
    const stats = parseValue(DashboardPagesStatsSchema, await readPagesStats(db))
    expect(stats).toMatchObject({ total: 2, variants: 3, published: 2, drafts: 1, scheduled: 1, offline: 0, deltaPublishedThisWeek: 2 })
    await updateLocale(db, de.id, { enabled: false })
    expect(await readPagesStats(db)).toMatchObject({ total: 2, published: 1, offline: 1, scheduled: 1 })
  })

  it('shows frozen live and scheduled paths and the correct locale draft titles', async () => {
    const { db, de } = await fixture()
    const home = await createDataRow(db, { tableId: 'pages', cells: { title: 'Home', slug: 'index' }, slug: 'index' })
    const post = await createDataRow(db, { tableId: 'posts', cells: { title: 'Source', slug: 'source' }, slug: 'source' })
    await createDataRow(db, { tableId: 'pages', cells: { title: 'Unfinished', slug: '' }, slug: '' })
    await createDataRow(db, { tableId: 'pages', cells: { title: 'Template', slug: 'template', templateEnabled: true }, slug: 'template' })
    await saveDataRowDraft(db, post.id, { cells: { title: 'Deutsch', slug: 'entwurf' }, slug: 'entwurf', localeId: de.id })
    await release(db, home.id, 'default', 1, '/')
    await release(db, post.id, de.id, 1, '/de/posts/live')
    await scheduleContentLocalizationPublish(db, post.id, de.id, '2026-12-01T00:00:00.000Z', { cells: { title: 'Geplant' }, slug: 'scheduled', publicPath: '/de/posts/scheduled' })
    await saveTableLocalization(db, 'posts', de.id, '/beitraege')
    const { rows } = parseValue(DashboardPublishLineupStatsSchema, await readPublishLineup(db))
    expect(rows.find((row) => row.id === home.id)?.path).toBe('/')
    expect(rows.find((row) => row.id === post.id && row.status === 'published')).toMatchObject({ localeId: de.id, path: '/de/posts/live', title: 'Deutsch' })
    expect(rows.find((row) => row.id === post.id && row.status === 'scheduled')?.path).toBe('/de/posts/scheduled')
    expect(rows.some((row) => row.title === 'Template')).toBe(false)
    expect(rows.find((row) => row.title === 'Unfinished')?.path).toBeNull()
  })

  it('bins every locale publication and resolves activity in the event language', async () => {
    const { db, de } = await fixture()
    const post = await createDataRow(db, { tableId: 'posts', cells: { title: 'Source', slug: 'source' }, slug: 'source' })
    await saveDataRowDraft(db, post.id, { cells: { title: 'Übersetzt', slug: 'uebersetzt' }, slug: 'uebersetzt', localeId: de.id })
    await release(db, post.id, 'default', 1, '/posts/source')
    await release(db, post.id, de.id, 2, '/de/posts/frozen')
    await release(db, post.id, de.id, 3, '/de/posts/frozen-new')
    await saveTableLocalization(db, 'posts', de.id, '/beitraege')
    await createAuditEvent(db, { actorUserId: null, action: 'data.row.update', targetId: post.id, targetType: 'dataRow', metadata: { tableId: 'posts', localeId: de.id } })
    await createAuditEvent(db, { actorUserId: null, action: 'data.row.publish', targetId: post.id, targetType: 'dataRow', metadata: { tableId: 'posts', localeId: de.id } })
    const posts = await readPostsStats(db, {}, { timeZone: 'UTC' })
    expect(posts).toMatchObject({ total: 1, variants: 2 })
    expect(posts.daily28.reduce((sum, count) => sum + count, 0)).toBe(3)
    const { rows } = await readRecentActivity(db)
    expect(rows.find((row) => row.action === 'data.row.update')?.targetCode).toBe('/de/beitraege/uebersetzt')
    expect(rows.find((row) => row.action === 'data.row.publish')?.targetCode).toBe('/de/posts/frozen-new')
  })
})
