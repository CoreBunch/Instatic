import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createDbClient, type DbClient } from '../../../server/db'
import { runMigrations } from '../../../server/db/runMigrations'
import { syncSystemRoles } from '../../../server/repositories/roles'

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
    // Mirror boot: system roles come from code, not from the migration seed.
    await syncSystemRoles(db)
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
  // Mirror boot: system roles come from code, not from the migration seed.
  await syncSystemRoles(db)

  return {
    db,
    cleanup: async () => {
      // Close before unlinking: the file, and its WAL/SHM siblings, stay
      // locked on Windows while the handle is open.
      await db.close()
      await rmWithRetry(path.dirname(tmpFile))
    },
  }
}

/**
 * Remove a test DB directory, retrying EBUSY with exponential backoff.
 *
 * On Windows the OS can keep the WAL/SHM siblings locked for a while after
 * the last SQLite handle is closed — the release is asynchronous, and
 * real-time antivirus scanners may hold a freshly written file for seconds
 * (observed up to ~5s on CI workstations). Every handle in the process is
 * already closed, so retrying is safe and turns a flaky teardown into a
 * clean one; on POSIX the first attempt always succeeds.
 */
async function rmWithRetry(dir: string): Promise<void> {
  const deadline = Date.now() + 15_000
  let waitMs = 100
  for (;;) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EBUSY' || Date.now() + waitMs > deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      waitMs = Math.min(waitMs * 2, 1000)
    }
  }
}
