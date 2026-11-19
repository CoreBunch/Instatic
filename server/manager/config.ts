/**
 * Manager API configuration.
 *
 * The Manager API (`/_instatic/manager/v1/*`) lets a supervising manager
 * (Instatic Desktop) move a full instance in and out of a running server and
 * manage its database snapshots. It exists only when the operator sets
 * `INSTATIC_MANAGER_TOKEN`; without it the whole namespace answers 404, the
 * same way `/_instatic/shutdown` does without its token.
 *
 * The working directory is resolved even when the API is disabled, because a
 * restore staged by a previous run must still be applied on the next boot.
 */
import { join, resolve } from 'node:path'
import { instanceStateDir } from '../instanceDir'
import { isSameOrInside } from './fsUtil'

export const MANAGER_NAMESPACE = '/_instatic/manager/'
export const MANAGER_API_PREFIX = '/_instatic/manager/v1'
export const MANAGER_API_VERSION = 1

/**
 * Exit code that means "restart me": a restore is staged and takes effect on
 * the next boot. Supervisors restart on it instead of treating it as a crash.
 */
export const MANAGER_RESTART_EXIT_CODE = 75

/** A manager token is equivalent to owning the instance, so short ones are refused. */
export const MANAGER_TOKEN_MIN_LENGTH = 32

export interface ManagerConfig {
  /** Null when the API is disabled (unset or too-short token). */
  token: string | null
  /** True when a token was provided but rejected for being too short. */
  tokenRejected: boolean
  /** Snapshots and staging live here. */
  dir: string
}

/**
 * The default working directory sits BESIDE THE DATABASE (`<db dir>/manager`),
 * so it is on persistent storage wherever the database is, and the database
 * swap is a same-filesystem rename. It must never sit inside `UPLOADS_DIR`:
 * that tree is served publicly at `/uploads/*`, and snapshots are full copies
 * of the database. Postgres instances have no database file; they fall back
 * to a sibling of the uploads directory. That is persistent only when the
 * volume holds the uploads directory's PARENT; a volume mounted on the
 * uploads directory itself needs `INSTATIC_MANAGER_DIR` set to a path on it.
 */
export function readManagerConfig(
  env: Record<string, string | undefined>,
  uploadsDir: string,
  databaseUrl: string,
): ManagerConfig {
  const raw = env.INSTATIC_MANAGER_TOKEN?.trim() ?? ''
  const accepted = raw.length >= MANAGER_TOKEN_MIN_LENGTH
  const override = env.INSTATIC_MANAGER_DIR?.trim()
  const dir = override
    ? resolve(override)
    : join(instanceStateDir(uploadsDir, databaseUrl), 'manager')
  return {
    token: accepted ? raw : null,
    tokenRejected: raw.length > 0 && !accepted,
    dir,
  }
}

/**
 * A layout the Manager API cannot operate on safely, or null when the layout
 * is fine. Each of these would let a restore expose or destroy data:
 *
 *  - manager dir inside uploads: snapshots would be publicly downloadable;
 *  - uploads inside the manager dir: staging cleanup would delete uploads;
 *  - database inside uploads: a transfer would list it as an upload and
 *    remove it as a stray right after installing it;
 *  - database inside the manager dir: same hazard from the other side.
 */
export function managerLayoutProblem(managerDir: string, uploadsDir: string, dbPath: string | null): string | null {
  if (isSameOrInside(uploadsDir, managerDir)) {
    return 'INSTATIC_MANAGER_DIR is inside UPLOADS_DIR, which is served publicly. Move it outside.'
  }
  if (isSameOrInside(managerDir, uploadsDir)) {
    return 'UPLOADS_DIR is inside INSTATIC_MANAGER_DIR. Keep them apart.'
  }
  if (dbPath && isSameOrInside(uploadsDir, dbPath)) {
    return 'The SQLite database is inside UPLOADS_DIR. Move the database outside the uploads directory.'
  }
  if (dbPath && isSameOrInside(managerDir, dbPath)) {
    return 'The SQLite database is inside INSTATIC_MANAGER_DIR. Keep them apart.'
  }
  return null
}
