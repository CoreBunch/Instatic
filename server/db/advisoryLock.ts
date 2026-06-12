/**
 * Scheduler leader election — the single owner of the `pg_try_advisory_lock` /
 * `pg_advisory_unlock` dance used by every recurring tick loop in the server.
 *
 * Why this lives here
 * ───────────────────
 * In an HA deployment several host instances run the same tick loops. Without
 * coordination they would all fire the same scheduled work (double-publish,
 * double-dispatch). A Postgres advisory lock lets exactly ONE instance be the
 * leader for a tick; everyone else no-ops until the next interval. The lock is
 * released between ticks so a leader crash hands off naturally.
 *
 * SQLite is single-process by definition, so there is no one to coordinate
 * with. `pg_try_advisory_lock` does not exist there and the call throws — we
 * catch and return the `'sqlite-leader'` sentinel so the caller always runs.
 *
 * Each tick loop passes its OWN lock key (so distinct loops don't contend) and
 * its OWN log prefix (so release failures are attributed to the right module).
 * The mechanism itself lives here, once.
 */
import type { DbClient } from './client'

/**
 * Token returned by `tryAcquireLeader`. Opaque to the caller; only used to
 * round-trip into `releaseLeader`. `null` means we couldn't get the lock
 * (another instance is the leader for this tick).
 *
 * For SQLite (single-instance), `tryAcquireLeader` always returns the sentinel
 * `'sqlite-leader'` because there's no one else to coordinate with.
 */
type LeaderToken = string | null

/** Sentinel returned when we actually hold a Postgres advisory lock. */
const PG_TOKEN = 'pg-advisory'
/** Sentinel returned on SQLite, where the caller is always the leader. */
const SQLITE_TOKEN = 'sqlite-leader'

/**
 * Try to become the tick leader for `lockKey`. Returns a token to pass to
 * `releaseLeader`, or `null` when another instance already holds the lock.
 */
export async function tryAcquireLeader(db: DbClient, lockKey: number): Promise<LeaderToken> {
  // Best-effort detection of Postgres via probing for a PG-only function.
  // `pg_try_advisory_lock` returns true if we got the lock, false if someone
  // else is holding it. SQLite throws on the call; we catch and fall through
  // to the sentinel.
  try {
    const { rows } = await db<{ got: boolean }>`
      select pg_try_advisory_lock(${lockKey}) as got
    `
    return rows[0]?.got ? PG_TOKEN : null
  } catch {
    // SQLite path — single instance by definition, so we're always leader.
    return SQLITE_TOKEN
  }
}

/**
 * Release a lock acquired via `tryAcquireLeader`. No-op for the SQLite sentinel.
 * `logPrefix` (e.g. `'[plugin-scheduler]'`) attributes a release failure to the
 * caller's module.
 */
export async function releaseLeader(
  db: DbClient,
  token: LeaderToken,
  lockKey: number,
  logPrefix: string,
): Promise<void> {
  if (token !== PG_TOKEN) return
  try {
    await db`select pg_advisory_unlock(${lockKey})`
  } catch (err) {
    console.error(`${logPrefix} failed to release advisory lock:`, err)
  }
}

/**
 * Run `fn` only if this instance wins the leader election for `lockKey`,
 * releasing the lock afterwards. Returns `fn`'s result when leader, or
 * `undefined` when another instance is the leader for this tick.
 */
export async function withSchedulerLeaderLock<T>(
  db: DbClient,
  lockKey: number,
  logPrefix: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const token = await tryAcquireLeader(db, lockKey)
  if (!token) return undefined
  try {
    return await fn()
  } finally {
    await releaseLeader(db, token, lockKey, logPrefix)
  }
}
