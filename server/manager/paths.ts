/**
 * Where the Manager API keeps things inside its working directory. Every
 * path is derived from the manager directory at the moment it is used, never
 * read back from a file: a marker on disk can say WHAT to do, not WHERE.
 */
import { join } from 'node:path'

export function snapshotsDir(managerDir: string): string {
  return join(managerDir, 'snapshots')
}

/** Copy of a snapshot waiting to become the live database. */
export function restoreStagingPath(managerDir: string): string {
  return join(managerDir, 'restore-staged.db')
}

export function transferDir(managerDir: string): string {
  return join(managerDir, 'transfer')
}

export function transferStatePath(managerDir: string): string {
  return join(transferDir(managerDir), 'state.json')
}

/** Uploaded database of the active transfer. */
export function stagedDatabasePath(managerDir: string): string {
  return join(transferDir(managerDir), 'database')
}

/** Uploaded files of the active transfer, laid out by relative path. */
export function stagedFilesDir(managerDir: string): string {
  return join(transferDir(managerDir), 'files')
}

export function pendingMarkerPath(managerDir: string): string {
  return join(managerDir, 'pending.json')
}

/** Why the last boot could not finish applying a staged restore, if it could not. */
export function restoreErrorPath(managerDir: string): string {
  return join(managerDir, 'restore-error.txt')
}

export function hashCachePath(managerDir: string): string {
  return join(managerDir, 'hash-cache.json')
}

/** The database a restore replaced, kept beside the live one as a one-step undo. */
export function preRestorePath(dbPath: string): string {
  return `${dbPath}.pre-restore`
}

/**
 * Postgres has no database file to set aside, so its undo copy is the
 * database written out as a SQLite file in the manager directory.
 */
export function postgresPreRestorePath(managerDir: string): string {
  return join(managerDir, 'pre-restore.db')
}
