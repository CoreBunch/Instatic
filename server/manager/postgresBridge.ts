/**
 * Moving a whole database between SQLite and Postgres.
 *
 * The Manager API's interchange format is a SQLite database file: it is what
 * a snapshot is, what a push uploads and what a pull downloads. A Postgres
 * instance speaks that format through this module:
 *
 *  - {@link exportPostgresToSqlite} writes the Postgres database out as a
 *    SQLite file (a snapshot, or the undo copy kept before a restore);
 *  - {@link importSqliteIntoPostgres} replaces the Postgres database with the
 *    contents of a SQLite file (a restore, or a pushed site).
 *
 * This works because both engines run the same migrations under the same
 * ids and end up with the same tables and columns (pinned by
 * `managerPostgresBridge.test.ts`). Only the column types differ, so every value
 * crosses as text and is cast on the Postgres side. Nothing here depends on
 * how the driver would map a JavaScript value to a Postgres type.
 *
 * The schema is always rebuilt at the SOURCE's migration level before rows
 * are copied, so a database from an older release lands in the shape it was
 * written in and the normal boot migrations bring it forward afterwards.
 */
import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { rm } from 'node:fs/promises'
import { pgMigrations } from '../db/migrations-pg'
import { sqliteMigrations } from '../db/migrations-sqlite'
import { runMigrations, type Migration } from '../db/runMigrations'
import { createSqliteClient } from '../db/sqlite'
import { vacuumInto } from './database'

/** Rows moved per round trip. Bounded so a large table never sits in memory. */
const BATCH_ROWS = 200
/** Postgres caps a statement at 65535 parameters; stay far below it. */
const MAX_PARAMS_PER_INSERT = 8000
/**
 * How long an import waits for another session to let go of a table. Without
 * a limit, one open `psql` or a running `pg_dump` would hold boot forever.
 */
const IMPORT_LOCK_TIMEOUT = '30s'

const MIGRATIONS_TABLE = 'schema_migrations'

interface PgColumn {
  name: string
  /** `format_type` output, e.g. `jsonb`, `timestamp with time zone`. */
  type: string
  generated: boolean
}

type ValueKind = 'integer' | 'float' | 'blob' | 'boolean' | 'text'

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function kindOf(pgType: string): ValueKind {
  if (pgType === 'boolean') return 'boolean'
  if (pgType === 'bytea') return 'blob'
  if (pgType === 'smallint' || pgType === 'integer' || pgType === 'bigint') return 'integer'
  if (pgType === 'real' || pgType === 'double precision' || pgType.startsWith('numeric')) return 'float'
  return 'text'
}

/** SQL that reads `column` as text in the form SQLite stores it. */
function readExpression(column: PgColumn): string {
  const ident = quoteIdent(column.name)
  if (column.type === 'bytea') return `encode(${ident}, 'hex')`
  if (column.type === 'boolean') return `${ident}::int::text`
  // ISO 8601 in UTC with milliseconds: what the server writes on SQLite.
  if (column.type === 'timestamp with time zone') {
    return `to_char(${ident} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  }
  if (column.type === 'timestamp without time zone') return `to_char(${ident}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  return `${ident}::text`
}

/** SQL that turns text parameter `$index` into a value of the column's type. */
function writeExpression(column: PgColumn, index: number): string {
  if (column.type === 'bytea') return `decode($${index}::text, 'hex')`
  if (column.type === 'boolean') return `($${index}::text = '1')`
  return `$${index}::text::${column.type}`
}

/** A value read from SQLite, as the text parameter Postgres casts from. */
function toPgText(value: unknown, kind: ValueKind): string | null {
  if (value === null || value === undefined) return null
  if (kind === 'blob') {
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value))
    return Buffer.from(bytes).toString('hex')
  }
  if (kind === 'boolean') return value === 1 || value === 1n || value === true || value === '1' || value === 'true' ? '1' : '0'
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return String(value)
}

/** Text read from Postgres, as the value SQLite stores. */
function toSqliteValue(text: unknown, kind: ValueKind): string | number | bigint | Uint8Array | null {
  if (text === null || text === undefined) return null
  const value = String(text)
  if (kind === 'blob') return Buffer.from(value, 'hex')
  if (kind === 'float') return Number(value)
  if (kind === 'integer' || kind === 'boolean') {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : BigInt(value)
  }
  return value
}

async function pgTables(sql: SQL): Promise<Map<string, PgColumn[]>> {
  const rows = await sql.unsafe<{ table: string; column: string; type: string; generated: boolean }[]>(`
    select c.relname as "table", a.attname as "column",
           format_type(a.atttypid, a.atttypmod) as "type",
           a.attgenerated <> '' as "generated"
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum
  `)
  const tables = new Map<string, PgColumn[]>()
  for (const row of rows) {
    const columns = tables.get(row.table) ?? []
    columns.push({ name: row.column, type: row.type, generated: row.generated })
    tables.set(row.table, columns)
  }
  return tables
}

function sqliteTables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all()
    .map((row) => row.name)
}

/** Columns that hold stored data: generated and hidden columns are left out. */
function sqliteColumns(db: Database, table: string): string[] {
  return db
    .query<{ name: string; hidden: number | bigint }, []>(`pragma table_xinfo(${quoteIdent(table)})`)
    .all()
    .filter((column) => Number(column.hidden) === 0)
    .map((column) => column.name)
}

/**
 * Every table this release of the server owns, on either engine. Read off a
 * throwaway in-memory SQLite database with all migrations applied, so it
 * needs no hand-kept list.
 */
async function ownedTables(): Promise<string[]> {
  const client = createSqliteClient(':memory:')
  try {
    await runMigrations(client, sqliteMigrations)
    const { rows } = await client.unsafe<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
    )
    return rows.map((row) => row.name)
  } finally {
    await client.close()
  }
}

/**
 * The migrations a database has applied. Throws when it carries one this
 * release does not know: its schema cannot be rebuilt here, and copying what
 * fits would quietly drop the rest.
 */
function migrationsUpTo(all: Migration[], appliedIds: string[]): Migration[] {
  const applied = new Set(appliedIds)
  const known = all.filter((migration) => applied.has(migration.id))
  if (known.length !== applied.size) {
    throw new Error('[manager] the database carries migrations this release does not know')
  }
  return known
}

// ---------------------------------------------------------------------------
// SQLite file -> Postgres
// ---------------------------------------------------------------------------

/**
 * Replace the Postgres database at `databaseUrl` with the contents of the
 * SQLite file. Runs in ONE transaction, schema changes included, so a
 * failure leaves the database exactly as it was.
 *
 * Only tables this server owns are dropped, emptied or altered: a database
 * shared with another application keeps that application's tables, rows and
 * constraints, and an import that would break something depending on ours
 * fails instead.
 */
export async function importSqliteIntoPostgres(databaseUrl: string, sqliteFile: string): Promise<void> {
  // Integers are read as bigint so a 64-bit value crosses without rounding.
  // Not opened read-only: a file whose header says WAL (a plain copy of a
  // live database) cannot be read by a connection that may not create the
  // `-shm` file beside it. Nothing here writes to it.
  const source = new Database(sqliteFile, { readwrite: true, safeIntegers: true })
  const sql = new SQL(databaseUrl)
  try {
    const sourceMigrationIds = source
      .query<{ id: string }, []>(`select id from ${MIGRATIONS_TABLE} order by id`)
      .all()
      .map((row) => row.id)
    const migrations = migrationsUpTo(pgMigrations, sourceMigrationIds)
    const owned = await ownedTables()

    await sql.begin(async (tx) => {
      // SQLite's `current_timestamp` shape has no zone marker and means UTC.
      await tx.unsafe("set local timezone = 'UTC'")
      await tx.unsafe(`set local lock_timeout = '${IMPORT_LOCK_TIMEOUT}'`)

      // No CASCADE: if another application's table or view depends on one of
      // ours, the import stops here rather than taking that object with it.
      await tx.unsafe(`drop table if exists ${owned.map(quoteIdent).join(', ')}`)
      await tx.unsafe(`create table ${MIGRATIONS_TABLE} (id text primary key, applied_at text not null default current_timestamp)`)
      for (const migration of migrations) await tx.unsafe(migration.sql)

      // Everything below touches owned tables only: the schema may hold
      // another application's tables, and those are not ours to change.
      const ownedSet = new Set(owned)
      const targets = new Map([...(await pgTables(tx))].filter(([table]) => ownedSet.has(table)))
      const sourceTables = sqliteTables(source)
      const missing = sourceTables.filter((table) => !targets.has(table))
      if (missing.length > 0) throw new Error(`[manager] the database has tables this release does not own: ${missing.join(', ')}`)

      // Rows reference each other in cycles (a row and its versions, a user
      // and their avatar), so the foreign keys are checked once, at the end.
      const foreignKeys = (
        await tx.unsafe<{ table: string; name: string; deferrable: boolean; deferred: boolean }[]>(`
          select c.relname as "table", k.conname as "name", k.condeferrable as "deferrable", k.condeferred as "deferred"
          from pg_constraint k
          join pg_class c on c.oid = k.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          where k.contype = 'f' and n.nspname = current_schema()
        `)
      ).filter((key) => ownedSet.has(key.table))
      for (const key of foreignKeys) {
        await tx.unsafe(`alter table ${quoteIdent(key.table)} alter constraint ${quoteIdent(key.name)} deferrable initially deferred`)
      }

      // Migrations seed rows (roles, system tables); the source has its own.
      await tx.unsafe(`truncate table ${[...targets.keys()].map(quoteIdent).join(', ')}`)

      for (const table of sourceTables) {
        const targetColumns = new Map((targets.get(table) ?? []).map((column) => [column.name, column]))
        const names = sqliteColumns(source, table)
        const unknown = names.filter((name) => !targetColumns.has(name))
        if (unknown.length > 0) {
          throw new Error(`[manager] ${table} has columns Postgres does not: ${unknown.join(', ')}`)
        }
        const columns = names.map((name) => targetColumns.get(name) as PgColumn).filter((column) => !column.generated)
        if (columns.length === 0) continue
        const kinds = columns.map((column) => kindOf(column.type))
        const rowsPerInsert = Math.max(1, Math.min(BATCH_ROWS, Math.floor(MAX_PARAMS_PER_INSERT / columns.length)))
        const insertPrefix = `insert into ${quoteIdent(table)} (${columns.map((column) => quoteIdent(column.name)).join(', ')}) values `

        const flush = async (batch: unknown[][]) => {
          if (batch.length === 0) return
          const tuples = batch.map(
            (_, row) => `(${columns.map((column, index) => writeExpression(column, row * columns.length + index + 1)).join(', ')})`,
          )
          const params = batch.flatMap((row) => row.map((value, index) => toPgText(value, kinds[index] as ValueKind)))
          try {
            await tx.unsafe(insertPrefix + tuples.join(', '), params)
          } catch (err) {
            throw new Error(`[manager] could not copy ${table} into Postgres: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
          }
        }

        const select = source.query<Record<string, unknown>, []>(
          `select ${columns.map((column) => quoteIdent(column.name)).join(', ')} from ${quoteIdent(table)}`,
        )
        let batch: unknown[][] = []
        for (const row of select.iterate()) {
          batch.push(columns.map((column) => row[column.name]))
          if (batch.length >= rowsPerInsert) {
            await flush(batch)
            batch = []
          }
        }
        await flush(batch)
      }

      await tx.unsafe('set constraints all immediate')
      // Put every constraint back exactly as its migration declared it.
      for (const key of foreignKeys) {
        const mode = !key.deferrable ? 'not deferrable' : key.deferred ? 'deferrable initially deferred' : 'deferrable initially immediate'
        await tx.unsafe(`alter table ${quoteIdent(key.table)} alter constraint ${quoteIdent(key.name)} ${mode}`)
      }
    })
  } finally {
    source.close()
    await sql.close()
  }
}

// ---------------------------------------------------------------------------
// Postgres -> SQLite file
// ---------------------------------------------------------------------------

/**
 * Write the Postgres database at `databaseUrl` to a new SQLite file at
 * `dest`, as one consistent view of the data. Returns false, writing
 * nothing, when the database has never been migrated.
 */
export async function exportPostgresToSqlite(databaseUrl: string, dest: string): Promise<boolean> {
  // The file is assembled beside `dest` and copied into place with
  // `VACUUM INTO` at the end, which leaves one compact, self-contained file:
  // no write-ahead log next to it, and nothing at `dest` until it is whole.
  const build = `${dest}.build`
  await removeSqliteFile(dest)
  await removeSqliteFile(build)
  const sql = new SQL(databaseUrl)
  try {
    const written = await sql.begin('isolation level repeatable read read only', async (tx) => {
      const sources = await pgTables(tx)
      if (!sources.has(MIGRATIONS_TABLE)) return false
      const applied = await tx.unsafe<{ id: string }[]>(`select id from ${MIGRATIONS_TABLE} order by id`)

      // Build the SQLite schema at the same migration level as the source.
      const client = createSqliteClient(build)
      try {
        await runMigrations(client, migrationsUpTo(sqliteMigrations, applied.map((row) => row.id)))
      } finally {
        await client.close()
      }

      const target = new Database(build)
      try {
        target.exec('PRAGMA foreign_keys = OFF')
        target.exec('begin')
        const targetTables = sqliteTables(target)
        const missing = [...sources.keys()].filter((table) => targetTables.includes(table) === false)
        // A table of another application sharing the database is not ours to copy.
        const owned = new Set(await ownedTables())
        const unexpected = missing.filter((table) => owned.has(table))
        if (unexpected.length > 0) throw new Error(`[manager] Postgres has tables SQLite does not: ${unexpected.join(', ')}`)

        for (const table of targetTables) {
          target.exec(`delete from ${quoteIdent(table)}`)
          const sourceColumns = new Map((sources.get(table) ?? []).map((column) => [column.name, column]))
          const columns = sqliteColumns(target, table)
            .map((name) => sourceColumns.get(name))
            .filter((column): column is PgColumn => column !== undefined)
          if (columns.length === 0) continue
          const kinds = columns.map((column) => kindOf(column.type))
          const insert = target.query(
            `insert into ${quoteIdent(table)} (${columns.map((column) => quoteIdent(column.name)).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
          )
          const cursor = quoteIdent(`instatic_export_${table}`)
          await tx.unsafe(
            `declare ${cursor} no scroll cursor for select ${columns.map((column, index) => `${readExpression(column)} as c${index}`).join(', ')} from ${quoteIdent(table)}`,
          )
          for (;;) {
            const rows = await tx.unsafe<Record<string, unknown>[]>(`fetch ${BATCH_ROWS} from ${cursor}`)
            if (rows.length === 0) break
            for (const row of rows) {
              insert.run(...columns.map((_, index) => toSqliteValue(row[`c${index}`], kinds[index] as ValueKind)))
            }
          }
          await tx.unsafe(`close ${cursor}`)
        }
        target.exec('commit')

        const violations = target.query('pragma foreign_key_check').all()
        if (violations.length > 0) throw new Error(`[manager] the exported database has ${violations.length} broken reference(s)`)
      } finally {
        target.close()
      }
      return true
    })
    if (written) vacuumInto(build, dest)
    return written
  } catch (err) {
    await removeSqliteFile(dest)
    throw err
  } finally {
    await removeSqliteFile(build)
    await sql.close()
  }
}

async function removeSqliteFile(path: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${path}${suffix}`, { force: true })
}

/** Size of the Postgres database in bytes, as Postgres reports it. */
export async function postgresDatabaseSize(databaseUrl: string): Promise<number> {
  const sql = new SQL(databaseUrl)
  try {
    const rows = await sql.unsafe<{ size: string }[]>('select pg_database_size(current_database())::text as size')
    return Number(rows[0]?.size ?? 0)
  } finally {
    await sql.close()
  }
}
