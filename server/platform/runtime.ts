import { createDbClient } from '../db'
import { runMigrations } from '../db/runMigrations'
import type { PlatformConfig } from './config'
import { PlatformAuthenticator } from './auth'
import { platformPgMigrations } from './db/migrations-pg'
import { platformSqliteMigrations } from './db/migrations-sqlite'
import type { DbClient } from '../db/client'

export interface PlatformRuntime {
  db: DbClient
  auth: PlatformAuthenticator
  config: PlatformConfig
}

export async function createPlatformRuntime(
  config: PlatformConfig,
): Promise<PlatformRuntime | null> {
  if (!config.enabled || config.authMode === 'disabled') return null
  if (!config.databaseUrl) throw new Error('Control-plane database URL is missing')

  const { db } = createDbClient(config.databaseUrl)
  const migrations = db.dialect === 'postgres'
    ? platformPgMigrations
    : platformSqliteMigrations
  await runMigrations(db, migrations)

  return {
    db,
    auth: new PlatformAuthenticator(db, config),
    config,
  }
}
