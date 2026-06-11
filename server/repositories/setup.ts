import type { DbClient } from '../db/client'

interface SetupStatus {
  hasSite: boolean
  hasAdmin: boolean
  hasOwner: boolean
  needsSetup: boolean
}

export async function getSetupStatus(db: DbClient): Promise<SetupStatus> {
  const [site, owner] = await Promise.all([
    db<{ count: number }>`select count(*) as count from site`,
    db<{ count: number }>`
      select count(*) as count
      from users
      where role_id = ${'owner'}
        and status = ${'active'}
        and deleted_at is null
    `,
  ])
  const hasSite = Number(site.rows[0]?.count ?? 0) > 0
  const hasOwner = Number(owner.rows[0]?.count ?? 0) > 0
  return { hasSite, hasAdmin: hasOwner, hasOwner, needsSetup: !hasSite || !hasOwner }
}

/**
 * Sticky setup-status memo, keyed by `DbClient` instance.
 *
 * `needsSetup` only ever transitions true → false: setup creates the site and
 * the first owner, and the app refuses to deactivate or delete the last
 * active owner. Once a status with `needsSetup === false` has been observed
 * it is final for the process lifetime.
 *
 * Keyed by client (WeakMap) rather than a bare module global so tests that
 * spin up a fresh database per test stay isolated without manual resets.
 */
let settledStatusByDb = new WeakMap<DbClient, SetupStatus>()

/**
 * Like {@link getSetupStatus}, but skips the two COUNT queries once setup is
 * known to be complete. The router consults setup status on every unmatched
 * GET (bot probes hit that path forever on a long-lived install), so the hot
 * path must not query the database. While setup is still pending the status
 * is re-queried live on every call, so an in-progress setup is observed
 * immediately.
 */
export async function getSetupStatusCached(db: DbClient): Promise<SetupStatus> {
  const settled = settledStatusByDb.get(db)
  if (settled) return settled
  const status = await getSetupStatus(db)
  if (!status.needsSetup) settledStatusByDb.set(db, status)
  return status
}

/** Drop all memoized statuses — for tests that rewind setup state out-of-band (raw SQL deletes). */
export function resetSetupStatusCacheForTests(): void {
  settledStatusByDb = new WeakMap()
}

export async function createSite(
  db: DbClient,
  name: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await db`
    insert into site (id, name, settings_json)
    values ('default', ${name}, ${settings})
    on conflict (id) do update
      set name = excluded.name,
          settings_json = excluded.settings_json,
          updated_at = current_timestamp
  `
}
