import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { createDbClient, isSqliteUrl, parseSqlitePath } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { runMigrations } from '../../../server/db/runMigrations'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-db-selection-'))
  let result: T | undefined
  let fnError: unknown
  let cleanupError: Error | undefined
  try {
    result = await fn(dir)
  } catch (e) {
    fnError = e
  } finally {
    // Retry delete — Windows may hold SQLite handles briefly after close.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (e) {
        const err = e as Error & { code?: string }
        if (err.code === 'EBUSY' && attempt < 4) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
          continue
        }
        cleanupError = e as Error
        break
      }
    }
  }
  if (fnError) throw fnError
  if (cleanupError) throw cleanupError
  return result!
}

describe('createDbClient — DATABASE_URL dialect selection', () => {
  test('recognizes every SQLite URL form used by server and dev tooling', () => {
    expect(isSqliteUrl('sqlite:./.tmp/dev.db')).toBe(true)
    expect(isSqliteUrl('file:/tmp/instatic.db')).toBe(true)
    expect(isSqliteUrl('/tmp/instatic.db')).toBe(true)
    expect(isSqliteUrl('postgres://instatic:secret@localhost:5432/instatic')).toBe(false)
    expect(isSqliteUrl('postgresql://instatic:secret@localhost:5432/instatic')).toBe(false)

    expect(parseSqlitePath('sqlite:./.tmp/dev.db')).toBe('./.tmp/dev.db')
    expect(parseSqlitePath('file:/tmp/instatic.db')).toBe('/tmp/instatic.db')
    expect(parseSqlitePath('/tmp/instatic.db')).toBe('/tmp/instatic.db')
  })

  test('creates SQLite clients, parent directories, and SQLite migrations for SQLite URLs', async () => {
    await withTempDir(async (dir) => {
      for (const databaseUrl of [
        `sqlite:${join(dir, 'sqlite-prefix', 'cms.db')}`,
        `file:${join(dir, 'file-prefix', 'cms.db')}`,
        join(dir, 'bare-path', 'cms.db'),
      ]) {
        const { db, migrations } = createDbClient(databaseUrl)

        expect(db.dialect).toBe('sqlite')
        expect(migrations).toBe(sqliteMigrations)

        await runMigrations(db, migrations)
        await runMigrations(db, migrations)

        const { rows } = await db<{ count: number }>`select count(*) as count from schema_migrations`
        expect(rows[0]?.count).toBe(sqliteMigrations.length)

        db.close?.()
      }
    })
  })

  test('selects Postgres clients and Postgres migrations for supported Postgres schemes', () => {
    for (const databaseUrl of [
      'postgres://instatic:secret@127.0.0.1:65432/instatic',
      'postgresql://instatic:secret@127.0.0.1:65432/instatic',
    ]) {
      const { db, migrations } = createDbClient(databaseUrl)

      expect(db.dialect).toBe('postgres')
      expect(migrations).toBe(pgMigrations)
    }
  })

  test('rejects unsupported DATABASE_URL schemes with an operator-facing message', () => {
    expect(() => createDbClient('mysql://instatic:secret@localhost/instatic'))
      .toThrow('Unsupported DATABASE_URL: mysql:. Expected sqlite:..., file:..., postgres://..., or postgresql://...')
  })
})
