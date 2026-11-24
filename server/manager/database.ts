/**
 * SQLite operations the Manager API runs outside the server's own `DbClient`:
 * taking a consistent copy of the live database, and inspecting or preparing
 * a staged database file before it replaces the live one.
 *
 * Postgres instances have no file to copy. They reach the same SQLite file
 * format through `postgresBridge.ts`; callers branch on {@link sqlitePathOf}.
 * Staged databases are always SQLite files, whichever engine will run them.
 */
import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { isSqliteUrl, parseSqlitePath } from '../db'

/** Absolute path of the live SQLite file, or null for a Postgres instance. */
export function sqlitePathOf(databaseUrl: string): string | null {
  if (!isSqliteUrl(databaseUrl)) return null
  return resolve(parseSqlitePath(databaseUrl))
}

/**
 * Write a consistent, compacted copy of the live database to `dest`.
 * `VACUUM INTO` is SQLite's documented live-safe backup: under WAL it reads a
 * snapshot while the server keeps writing.
 */
export function vacuumInto(dbPath: string, dest: string): void {
  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 10000')
    db.query('VACUUM INTO ?').run(dest)
  } finally {
    db.close()
  }
}

export interface StagedDatabaseReport {
  integrityOk: boolean
  migrationIds: string[]
}

/** Integrity-check a staged database file and read the migrations it carries. */
export function inspectStagedDatabase(file: string): StagedDatabaseReport {
  const db = new Database(file)
  try {
    const integrity = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all()
    const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === 'ok'
    const hasTable = db
      .query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name = 'schema_migrations'")
      .all().length > 0
    const migrationIds = hasTable
      ? db.query<{ id: string }, []>('select id from schema_migrations order by id').all().map((row) => row.id)
      : []
    return { integrityOk, migrationIds }
  } finally {
    db.close()
  }
}

/**
 * Drop every login credential the server itself issued from a staged
 * database: browser sessions, paired CLI credentials and MCP OAuth codes and tokens. Credentials
 * minted on the source machine must not become valid on the host the data is
 * pushed to. Connector tokens an operator created on purpose are site
 * configuration and travel with the rest of the data.
 */
export function revokeStagedSessions(file: string): void {
  const db = new Database(file)
  try {
    const tables = new Set(
      db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all().map((row) => row.name),
    )
    for (const table of ['sessions', 'ai_mcp_oauth_tokens', 'ai_mcp_oauth_codes']) {
      // Table names are the fixed literals above, never caller input.
      if (tables.has(table)) db.exec(`delete from ${table}`)
    }
    if (tables.has('service_accounts')) {
      db.exec('update service_accounts set token_hash = null, code_hash = null, code_challenge = null, code_expires_at = null')
    }
  } finally {
    db.close()
  }
}

/**
 * Fold the write-ahead log of a database nobody has open into its main file.
 * Best effort: a file that cannot be opened is left as it is.
 */
export function checkpointDatabase(file: string): void {
  try {
    const db = new Database(file)
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      db.close()
    }
  } catch {
    // The file is about to be set aside as an undo copy either way.
  }
}
