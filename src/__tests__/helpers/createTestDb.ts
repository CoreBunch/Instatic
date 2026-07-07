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
 * Postgres instance instead. The helper supports that mode at the type level;
 * connection-pool teardown is left to process exit until DbClient grows a
 * close() method.
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
        // TODO: extend DbClient with a close() method to properly terminate the
        // Postgres connection pool. For now the process-level teardown is enough
        // for the opt-in PG test mode.
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
      // Close the DB connection before removing the temp directory.
      // On Windows SQLite holds a file lock; deleting while open throws EBUSY.
      db.close?.()
      // Retry delete a few times — Windows may hold the handle briefly after close.
      const dir = path.dirname(tmpFile)
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fs.rm(dir, { recursive: true, force: true })
          return
        } catch (e) {
          const err = e as Error & { code?: string }
          if (err.code === 'EBUSY' && attempt < 4) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
            continue
          }
          throw e
        }
      }
    },
  }
}
