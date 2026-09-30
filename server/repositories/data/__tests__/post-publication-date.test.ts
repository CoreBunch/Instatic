import { describe, expect, it } from 'bun:test'
import { MAIN_SCOPE } from '../../../branches/scope'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { getDataRow } from '../rows/read'
import { upsertDataRowDraft } from '../rows/mutations'
import { persistDataRowPublish } from '../publish'
import { getDataTable } from '../tables'

describe('Posts publication date', () => {
  it('migrates existing rows and versions to the editable date field', async () => {
    const db = createSqliteClient(':memory:')
    const migrationsBeforePublicationDate = sqliteMigrations.filter(
      (migration) => ![
        '031_posts_publication_date',
        '032_posts_publication_date_from_body',
      ].includes(migration.id),
    )
    await runMigrations(db, migrationsBeforePublicationDate)

    await upsertDataRowDraft(
      db,
      MAIN_SCOPE,
      {
        id: 'historic-post',
        tableId: 'posts',
        cells: { title: 'Historic post', slug: 'historic-post' },
        slug: 'historic-post',
      },
      null,
    )
    await persistDataRowPublish(db, 'historic-post', null)
    await db.unsafe(`
      update data_rows
         set published_at = '2025-08-12T12:00:00.000Z',
             cells_json = json_remove(cells_json, '$.date')
       where id = 'historic-post';
      update data_row_versions
         set published_at = '2025-08-12T12:00:00.000Z',
             cells_json = json_remove(cells_json, '$.date')
       where row_id = 'historic-post';
    `)

    await runMigrations(db, sqliteMigrations)

    const posts = await getDataTable(db, MAIN_SCOPE, 'posts')
    expect(posts?.fields).toContainEqual(expect.objectContaining({
      id: 'date',
      label: 'Publication date',
      type: 'date',
    }))
    expect((await getDataRow(db, MAIN_SCOPE, 'historic-post'))?.cells['date']).toBe('2025-08-12')

    const { rows: versions } = await db<{ cells_json: Record<string, unknown> }>`
      select cells_json
        from data_row_versions
       where row_id = ${'historic-post'}
    `
    expect(versions[0]?.cells_json['date']).toBe('2025-08-12')
  })

  it('prefers an original archive date embedded in the opening markdown line', async () => {
    const db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations.filter(
      (migration) => migration.id !== '032_posts_publication_date_from_body',
    ))

    await upsertDataRowDraft(
      db,
      MAIN_SCOPE,
      {
        id: 'imported-post',
        tableId: 'posts',
        cells: {
          title: 'Imported post',
          slug: 'imported-post',
          date: '2026-09-29',
          body: '**Veröffentlicht am 12.08.2025.**\n\nArchivinhalt',
        },
        slug: 'imported-post',
      },
      null,
    )
    await persistDataRowPublish(db, 'imported-post', null)
    await runMigrations(db, sqliteMigrations)

    expect((await getDataRow(db, MAIN_SCOPE, 'imported-post'))?.cells['date']).toBe('2025-08-12')
    const { rows: versions } = await db<{ cells_json: Record<string, unknown> }>`
      select cells_json
        from data_row_versions
       where row_id = ${'imported-post'}
    `
    expect(versions[0]?.cells_json['date']).toBe('2025-08-12')
  })

  it('fills today for a newly published post and preserves an authored date', async () => {
    const db = createSqliteClient(':memory:')
    await runMigrations(db, sqliteMigrations)

    await upsertDataRowDraft(
      db,
      MAIN_SCOPE,
      {
        id: 'new-post',
        tableId: 'posts',
        cells: { title: 'New post', slug: 'new-post', date: '' },
        slug: 'new-post',
      },
      null,
    )
    await persistDataRowPublish(db, 'new-post', null)
    expect((await getDataRow(db, MAIN_SCOPE, 'new-post'))?.cells['date']).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    await upsertDataRowDraft(
      db,
      MAIN_SCOPE,
      {
        id: 'backdated-post',
        tableId: 'posts',
        cells: { title: 'Backdated post', slug: 'backdated-post', date: '2024-03-01' },
        slug: 'backdated-post',
      },
      null,
    )
    await persistDataRowPublish(db, 'backdated-post', null)
    expect((await getDataRow(db, MAIN_SCOPE, 'backdated-post'))?.cells['date']).toBe('2024-03-01')
  })
})
