import type { DbClient } from './client'

export interface Migration {
  id: string
  sql: string
  /**
   * SQLite-only: run this migration with `PRAGMA foreign_keys = OFF`.
   *
   * Required for table REBUILDS of a parent referenced by `ON DELETE
   * RESTRICT` children (e.g. data_tables ← data_rows.table_id): RESTRICT
   * fires immediately even under `defer_foreign_keys`, so the populated
   * parent can't be dropped mid-rebuild, and renaming it away doesn't help —
   * since SQLite 3.25 a RENAME always rewrites child FK clauses to follow
   * it. `foreign_keys` is a no-op inside a transaction, so the runner
   * toggles it around this migration's transaction and verifies integrity
   * with `foreign_key_check` before re-enabling.
   *
   * Never set this on a PG migration — `pragma` is SQLite syntax.
   */
  disableForeignKeys?: boolean
}

/**
 * Apply any pending migrations to the database. Creates the schema_migrations
 * tracking table if it doesn't already exist, then runs each migration that
 * hasn't been recorded yet — inside a transaction so a partial failure leaves
 * the database unchanged.
 *
 * The schema_migrations table uses portable SQL (TEXT + current_timestamp) so
 * this function works identically against both the Postgres and SQLite adapters.
 */
export async function runMigrations(db: DbClient, migrations: Migration[]): Promise<void> {
  await db.unsafe(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at text not null default current_timestamp
    )
  `)

  for (const migration of migrations) {
    const { rows } = await db<{ id: string }>`
      select id from schema_migrations where id = ${migration.id}
    `
    if (rows.length > 0) continue

    // FK enforcement can only be toggled OUTSIDE a transaction (the pragma is
    // a documented no-op inside one) — see `Migration.disableForeignKeys`.
    if (migration.disableForeignKeys) {
      await db.unsafe('pragma foreign_keys = off')
    }
    try {
      await db.transaction(async (tx) => {
        // migration.sql is a multi-statement DDL/DML string — unsafe() is
        // required because tagged templates cannot accept a runtime string value,
        // and multi-statement batches are not supported by the parameterised path.
        await tx.unsafe(migration.sql)
        await tx`insert into schema_migrations (id) values (${migration.id})`
      })
      if (migration.disableForeignKeys) {
        // The rebuild ran unenforced — prove referential integrity before
        // re-enabling enforcement so a buggy migration fails loudly here
        // instead of corrupting silently.
        const { rows: violations } = await db<{ table: string }>`pragma foreign_key_check`
        if (violations.length > 0) {
          throw new Error(
            `[migrations] ${migration.id} left ${violations.length} foreign-key violation(s)`,
          )
        }
      }
    } finally {
      if (migration.disableForeignKeys) {
        await db.unsafe('pragma foreign_keys = on')
      }
    }
  }
}
