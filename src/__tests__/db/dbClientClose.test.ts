/**
 * Cover for DbClient.close().
 *
 * Test teardown deletes the temp directory holding a file-backed SQLite
 * database. Windows refuses to unlink a file whose handle is still open, so
 * every teardown path must release the client first — that is the defect
 * behind the Windows suite failures in #284. The EBUSY symptom itself is not
 * portable, so these tests assert the invariant instead: after close() the
 * handle is released and the file is removable.
 */
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { createSqliteClient } from '../../../server/db/sqlite'
import { createTestDb } from '../helpers/createTestDb'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-db-close-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('DbClient.close', () => {
  test('releases the handle so later queries reject', async () => {
    await withTempDir(async (dir) => {
      const db = createSqliteClient(join(dir, 'test.db'))
      const { rows } = await db<{ one: number }>`select 1 as one`
      expect(rows[0]?.one).toBe(1)

      await db.close()

      await expect(db`select 1 as one`).rejects.toThrow()
    })
  })

  test('is safe to call more than once', async () => {
    await withTempDir(async (dir) => {
      const db = createSqliteClient(join(dir, 'test.db'))
      await db`select 1`
      await db.close()
      await expect(db.close()).resolves.toBeUndefined()
    })
  })

  test('leaves the database file removable, including its WAL siblings', async () => {
    await withTempDir(async (dir) => {
      // createSqliteClient opens the file directly; only createDbClient
      // creates parent directories.
      const nested = join(dir, 'nested')
      await mkdir(nested, { recursive: true })
      const db = createSqliteClient(join(nested, 'test.db'))
      // Force a write so the WAL and SHM siblings actually exist.
      await db.unsafe('create table t (id integer primary key)')
      await db.unsafe('insert into t (id) values (1)')
      expect((await readdir(nested)).length).toBeGreaterThan(0)

      await db.close()

      await expect(rm(nested, { recursive: true, force: true })).resolves.toBeUndefined()
    })
  })

  test('createTestDb cleanup closes the client before removing the directory', async () => {
    const { db, cleanup } = await createTestDb()
    await db`select 1`

    await cleanup()

    await expect(db`select 1`).rejects.toThrow()
  })
})
