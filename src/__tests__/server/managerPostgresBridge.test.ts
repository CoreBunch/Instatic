/**
 * Integration tests: moving a database between SQLite and Postgres
 * (`server/manager/postgresBridge.ts`).
 *
 * They need a real Postgres, so they run only when
 * `INSTATIC_TEST_POSTGRES_URL` names a database the tests may wipe, e.g.
 * `postgres://localhost/instatic_bridge_test`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDbClient } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { exportPostgresToSqlite, importSqliteIntoPostgres } from '../../../server/manager/postgresBridge'

const POSTGRES_URL = process.env.INSTATIC_TEST_POSTGRES_URL

let root = ''
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'manager-bridge-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A migrated SQLite site with one row of every awkward type. */
async function seededSqlite(name: string, migrations = sqliteMigrations): Promise<string> {
  const file = join(root, name)
  const { db } = createDbClient(`sqlite:${file}`)
  await runMigrations(db, migrations)
  await db.close()
  const raw = new Database(file)
  // JSON, a `current_timestamp`-shaped stamp, a blob, and a row that refers
  // to one inserted after it (order Postgres would reject row by row).
  raw.exec('PRAGMA foreign_keys = OFF')
  raw.exec(`insert into site (id, name, settings_json) values ('default', 'Bridge', '{"name":"Bridge","nested":{"n":[1,2,3]}}')`)
  raw.exec("insert into media_folders (id, name, slug, parent_id, created_at) values ('child', 'Child', 'child', 'parent', '2026-01-02 03:04:05')")
  raw.exec("insert into media_folders (id, name, slug, parent_id, created_at) values ('parent', 'Parent', 'parent', null, '2026-01-02 03:04:05')")
  raw.query('insert into collab_documents (doc_id, state_blob) values (?, ?)').run('doc', new Uint8Array([0, 1, 2, 254, 255]))
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  raw.close()
  return file
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all()
    .map((row) => row.name)
}

async function wipePostgres(url: string): Promise<void> {
  const sql = new SQL(url)
  try {
    const tables = await sql.unsafe<{ tablename: string }[]>('select tablename from pg_tables where schemaname = current_schema()')
    if (tables.length > 0) await sql.unsafe(`drop table ${tables.map((t) => `"${t.tablename}"`).join(', ')} cascade`)
  } finally {
    await sql.close()
  }
}

describe.skipIf(!POSTGRES_URL)('Manager API: SQLite and Postgres', () => {
  const url = POSTGRES_URL as string

  it('both engines migrate to the same tables and stored columns', async () => {
    await wipePostgres(url)
    const { db } = createDbClient(url)
    await runMigrations(db, pgMigrations)
    const pg = await db.unsafe<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = current_schema() and is_generated = 'NEVER'",
    )
    await db.close()
    const sqlite = new Database(await seededSqlite('parity.db'), { readonly: true })
    const sqliteColumns = tableNames(sqlite).flatMap((table) =>
      sqlite
        .query<{ name: string; hidden: number }, []>(`pragma table_xinfo("${table}")`)
        .all()
        .filter((column) => column.hidden === 0)
        .map((column) => `${table}.${column.name}`),
    )
    sqlite.close()
    expect(pg.rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual(sqliteColumns.sort())
  })

  it('a SQLite database survives the trip through Postgres and back', async () => {
    await wipePostgres(url)
    const source = await seededSqlite('source.db')
    await importSqliteIntoPostgres(url, source)
    const back = join(root, 'back.db')
    expect(await exportPostgresToSqlite(url, back)).toBe(true)
    expect(existsSync(`${back}-wal`)).toBe(false)
    expect(existsSync(`${back}.build`)).toBe(false)

    const a = new Database(source, { readonly: true })
    const b = new Database(back, { readonly: true })
    expect(tableNames(b)).toEqual(tableNames(a))
    for (const table of tableNames(a)) {
      const count = (db: Database) => db.query<{ n: number }, []>(`select count(*) as n from "${table}"`).get()?.n
      expect(`${table}:${count(b)}`).toBe(`${table}:${count(a)}`)
    }
    const folders = b.query<{ id: string; parent_id: string | null; created_at: string }, []>('select id, parent_id, created_at from media_folders order by id').all()
    expect(folders).toEqual([
      // The zone-less stamp meant UTC and comes back as ISO 8601.
      { id: 'child', parent_id: 'parent', created_at: '2026-01-02T03:04:05.000Z' },
      { id: 'parent', parent_id: null, created_at: '2026-01-02T03:04:05.000Z' },
    ])
    const settings = b.query<{ settings_json: string }, []>('select settings_json from site').get()
    expect(JSON.parse(settings?.settings_json ?? 'null')).toEqual({ name: 'Bridge', nested: { n: [1, 2, 3] } })
    const blob = b.query<{ state_blob: Uint8Array }, []>("select state_blob from collab_documents where doc_id = 'doc'").get()
    expect([...(blob?.state_blob ?? [])]).toEqual([0, 1, 2, 254, 255])
    a.close()
    b.close()
  })

  it('an older database lands at its own migration level, and boot brings it forward', async () => {
    await wipePostgres(url)
    const older = sqliteMigrations.slice(0, -1)
    const file = join(root, 'older.db')
    const { db: sqlite } = createDbClient(`sqlite:${file}`)
    await runMigrations(sqlite, older)
    await sqlite.close()

    // The target already ran every migration, as a live server has.
    const target = createDbClient(url)
    await runMigrations(target.db, pgMigrations)
    await importSqliteIntoPostgres(url, file)
    const applied = await target.db<{ id: string }>`select id from schema_migrations order by id`
    expect(applied.rows.map((row) => row.id)).toEqual(older.map((migration) => migration.id))
    await runMigrations(target.db, pgMigrations)
    const after = await target.db<{ id: string }>`select id from schema_migrations order by id`
    expect(after.rows).toHaveLength(pgMigrations.length)
    await target.db.close()
  })

  it('a failed import leaves Postgres as it was, and other tables alone', async () => {
    await wipePostgres(url)
    const good = await seededSqlite('good.db')
    await importSqliteIntoPostgres(url, good)
    const sql = new SQL(url)
    await sql.unsafe('create table not_instatic (id integer primary key)')

    // A row that points at a folder that does not exist.
    const bad = await seededSqlite('bad.db')
    const raw = new Database(bad)
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec("insert into media_folders (id, name, slug, parent_id) values ('orphan', 'Orphan', 'orphan', 'nowhere')")
    raw.close()
    await expect(importSqliteIntoPostgres(url, bad)).rejects.toThrow()

    const folders = await sql.unsafe<{ id: string }[]>('select id from media_folders order by id')
    expect(folders.map((row) => row.id)).toEqual(['child', 'parent'])
    const kept = await sql.unsafe("select 1 from pg_tables where tablename = 'not_instatic'")
    expect(kept).toHaveLength(1)
    await sql.unsafe('drop table not_instatic')
    await sql.close()
  })
})
