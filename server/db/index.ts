import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPostgresClient } from './postgres'
import { createSqliteClient } from './sqlite'
import { pgMigrations } from './migrations-pg'
import { sqliteMigrations } from './migrations-sqlite'
import type { DbClient, DbResult } from './client'
import type { Migration } from './runMigrations'

export type { DbClient, DbResult }

/**
 * True for any DATABASE_URL that selects the SQLite adapter:
 *   sqlite:<path>  |  file:<path>  |  <bare path>.db
 *
 * Exported so callers (e.g. scripts/dev.ts) can branch on the same rule
 * createDbClient uses internally — keeps URL parsing in one place.
 */
export function isSqliteUrl(databaseUrl: string): boolean {
  return (
    databaseUrl.startsWith('sqlite:') ||
    databaseUrl.startsWith('file:') ||
    databaseUrl.endsWith('.db')
  )
}

class UnsupportedDatabaseUrlError extends Error {
  constructor(databaseUrl: string) {
    const prefix = /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.exec(databaseUrl)?.[0] ?? databaseUrl
    super(
      `Unsupported DATABASE_URL: ${prefix}. Expected sqlite:..., file:..., postgres://..., or postgresql://...`,
    )
    this.name = 'UnsupportedDatabaseUrlError'
  }
}

/**
 * Strip the `sqlite:` / `file:` prefix from a SQLite-flavoured DATABASE_URL
 * and return the bare filesystem path. Exported for callers (e.g. the
 * storage dashboard widget) that need to stat the on-disk database file.
 * Only call this when `isSqliteUrl(databaseUrl)` is true — Postgres URLs
 * passed in here would be returned unchanged.
 */
export function parseSqlitePath(databaseUrl: string): string {
  if (databaseUrl.startsWith('sqlite:')) return databaseUrl.slice('sqlite:'.length)
  if (databaseUrl.startsWith('file:')) return databaseUrl.slice('file:'.length)
  return databaseUrl
}

/**
 * Create a DB client and select the matching migrations array based on the
 * DATABASE_URL scheme:
 *
 *   sqlite:<path>     — SQLite via bun:sqlite (relative or absolute path)
 *   file:<path>       — same as sqlite:
 *   <path>.db         — same as sqlite: (bare filesystem path ending in .db)
 *   postgres://…      — Postgres via Bun.SQL
 *   postgresql://…    — same as postgres://
 *
 * For SQLite, the parent directory of the database file is created
 * automatically so callers don't need to pre-create it.
 */
export function createDbClient(databaseUrl: string): { db: DbClient; migrations: Migration[] } {
  if (isSqliteUrl(databaseUrl)) {
    const path = parseSqlitePath(databaseUrl)
    mkdirSync(dirname(path), { recursive: true })
    return {
      db: createSqliteClient(path),
      migrations: sqliteMigrations,
    }
  }

  if (databaseUrl.startsWith('postgres:') || databaseUrl.startsWith('postgresql:')) {
    return {
      db: createPostgresClient(databaseUrl),
      migrations: pgMigrations,
    }
  }

  throw new UnsupportedDatabaseUrlError(databaseUrl)
}
