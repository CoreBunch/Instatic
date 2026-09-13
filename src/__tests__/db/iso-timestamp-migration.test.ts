import { describe, test, expect } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { ISO_TIMESTAMP_COLUMNS_030, sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { runMigrations } from '../../../server/db/runMigrations'

const MIGRATION_ID = '030_iso_timestamps'

/**
 * Migration 030 rewrites every `*_at` text value stamped by SQL
 * `current_timestamp` (`YYYY-MM-DD HH:MM:SS[.SSS]`) to ISO 8601 UTC, so a
 * column never mixes the two shapes: the space form sorts before the `T` form
 * and compares wrongly against a bound ISO cutoff.
 */
describe('migration 030_iso_timestamps', () => {
  test('its column list covers every *_at text column in the schema it ships against', async () => {
    const db = createSqliteClient(':memory:')
    try {
      await runMigrations(db, sqliteMigrations.filter((m) => m.id <= MIGRATION_ID))
      const { rows: tables } = await db<{ name: string }>`
        select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`
      const covered = new Map(ISO_TIMESTAMP_COLUMNS_030.map(([table, columns]) => [table, new Set(columns)]))
      const missing: string[] = []
      for (const { name } of tables) {
        const { rows: columns } = await db.unsafe<{ name: string; type: string }>(`pragma table_info(${name})`)
        for (const column of columns) {
          if (!column.name.endsWith('_at') || column.type.toLowerCase() !== 'text') continue
          if (!covered.get(name)?.has(column.name)) missing.push(`${name}.${column.name}`)
        }
      }
      expect(missing).toEqual([])
    } finally {
      await db.close()
    }
  })

  test('rewrites space-form stamps to ISO 8601 UTC and leaves ISO values and nulls alone', async () => {
    const db = createSqliteClient(':memory:')
    try {
      await runMigrations(db, sqliteMigrations.filter((m) => m.id < MIGRATION_ID))
      await db`
        insert into users (id, email, email_normalized, display_name, password_hash, role_id,
                           created_at, updated_at, last_login_at, deleted_at)
        values (${'u1'}, ${'a@example.com'}, ${'a@example.com'}, ${'A'}, ${'hash'}, ${'member'},
                ${'2026-09-11T08:00:00.000Z'}, ${'2026-09-11 18:00:00'}, ${'2026-09-11 18:00:00.123'}, ${null})`

      await runMigrations(db, sqliteMigrations)

      // Aliases without the `_at` suffix bypass the adapter's read-side
      // normalisation, so this observes what is actually stored.
      const { rows } = await db<{ created: string; updated: string; login: string; deleted: string | null }>`
        select created_at as created, updated_at as updated, last_login_at as login, deleted_at as deleted
        from users where id = ${'u1'}`
      expect(rows[0]).toEqual({
        created: '2026-09-11T08:00:00.000Z',
        updated: '2026-09-11T18:00:00.000Z',
        login: '2026-09-11T18:00:00.123Z',
        deleted: null,
      })
    } finally {
      await db.close()
    }
  })
})
