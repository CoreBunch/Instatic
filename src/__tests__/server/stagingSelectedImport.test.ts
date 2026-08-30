import { describe, expect, it } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { applySiteBundle } from '../../../server/handlers/cms/import'
import { createDataRow, listDataRows } from '../../../server/repositories/data/rows'
import { listDataTables } from '../../../server/repositories/data/tables'

describe('replace-selected import', () => {
  it('replaces selected rows while preserving every unselected table', async () => {
    const db = createSqliteClient(':memory:')
    try {
      await runMigrations(db, sqliteMigrations)
      await handleCmsRequest(new Request('http://localhost/admin/api/cms/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          siteName: 'Selected import test',
          email: 'owner@selected-import.test',
          password: 'long-enough-password',
        }),
      }), db)
      const oldPost = await createDataRow(db, {
        tableId: 'posts',
        cells: { title: 'Old post', slug: 'old-post' },
        slug: 'old-post',
      })
      const page = await createDataRow(db, {
        tableId: 'pages',
        cells: { title: 'Kept page', slug: 'kept-page' },
        slug: 'kept-page',
      })
      const postsTable = (await listDataTables(db)).find((table) => table.id === 'posts')!
      const now = new Date().toISOString()

      const result = await applySiteBundle(db, {
        schemaVersion: 1,
        exportedAt: now,
        tables: [postsTable],
        rows: [{
          id: 'staged-post',
          tableId: 'posts',
          cells: { title: 'Staged post', slug: 'staged-post' },
          slug: 'staged-post',
          status: 'draft',
          authorUserId: null,
          createdByUserId: null,
          updatedByUserId: null,
          publishedByUserId: null,
          author: null,
          createdBy: null,
          updatedBy: null,
          publishedBy: null,
          createdAt: now,
          updatedAt: now,
          publishedAt: null,
          scheduledPublishAt: null,
          deletedAt: null,
        }],
      }, 'replace-selected')

      expect(result.strategy).toBe('replace-selected')
      expect((await listDataRows(db, 'posts')).map((row) => row.id)).toEqual(['staged-post'])
      expect((await listDataRows(db, 'pages')).map((row) => row.id)).toContain(page.id)
      expect((await listDataRows(db, 'posts')).map((row) => row.id)).not.toContain(oldPost.id)
    } finally {
      await db.close()
    }
  })
})
