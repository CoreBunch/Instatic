import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createDbClient, type DbClient } from '../../../server/db'
import { runMigrations } from '../../../server/db/runMigrations'

export interface TestDb {
  db: DbClient
  cleanup: () => Promise<void>
}

/**
 * Create a fresh DB for tests. Defaults to an isolated temp-file SQLite DB
 * with all migrations applied. Each call produces a unique, independent DB.
 *
 * Set `DB=postgres TEST_POSTGRES_URL=postgres://...` to run against a real
 * Postgres instance instead.
 *
 * `cleanup()` closes the client before removing anything on disk. Windows
 * refuses to unlink a file that is still open, so a SQLite handle left to
 * garbage collection makes teardown fail there with EBUSY.
 *
 * @example
 * const { db, cleanup } = await createTestDb()
 * try {
 *   // use db
 * } finally {
 *   await cleanup()
 * }
 */
export async function createTestDb(): Promise<TestDb> {
  if (process.env['DB'] === 'postgres') {
    const url = process.env['TEST_POSTGRES_URL']
    if (!url) throw new Error('TEST_POSTGRES_URL must be set when DB=postgres')
    const { db, migrations } = createDbClient(url)
    await runMigrations(db, migrations)
    return {
      db,
      cleanup: async () => {
        await db.close()
      },
    }
  }

  // Default: SQLite at a unique per-test temp file. createDbClient creates the
  // parent directory automatically via mkdirSync, so no pre-creation needed.
  const tmpFile = path.join(os.tmpdir(), `cms-test-${crypto.randomUUID()}`, 'test.db')
  const { db, migrations } = createDbClient(`sqlite:${tmpFile}`)
  await runMigrations(db, migrations)

  return {
    db,
    cleanup: async () => {
      // Close before unlinking: the file, and its WAL/SHM siblings, stay
      // locked on Windows while the handle is open.
      await db.close()
      await fs.rm(path.dirname(tmpFile), { recursive: true, force: true })
    },
  }
}
