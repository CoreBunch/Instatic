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
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDbClient } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { exportPostgresToSqlite, importSqliteIntoPostgres } from '../../../server/manager/postgresBridge'
import { applyPendingRestore, writePendingRestore } from '../../../server/manager/pending'
import { postgresPreRestorePath, restoreStagingPath } from '../../../server/manager/paths'

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
  // A 64-bit integer no JavaScript number holds, and a stamp with milliseconds.
  raw.exec("insert into collab_documents (doc_id, state_blob, seq, updated_at) values ('big', x'', 9007199254740993, '2026-03-04T05:06:07.089Z')")
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

/**
 * Every row of a table in a form that is the same before and after the trip:
 * Postgres hands back a zone-less stamp as ISO 8601 and a JSON document with
 * its keys reordered, and neither is a change to the data.
 */
function tableRows(db: Database, table: string): string[] {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]))
    }
    return value
  }
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'bigint') return `int:${value}`
    if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString('hex')}`
    if (typeof value !== 'string') return value
    const stamp = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value)
    if (stamp) return `${stamp[1]}T${stamp[2]}.000Z`
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return JSON.stringify(canonical(JSON.parse(value)))
      } catch {
        return value
      }
    }
    return value
  }
  return db
    .query<Record<string, unknown>, []>(`select * from "${table}"`)
    .all()
    .map((row) => JSON.stringify(Object.entries(row).map(([column, value]) => [column, normalize(value)])))
    .sort()
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

    const a = new Database(source, { readonly: true, safeIntegers: true })
    const b = new Database(back, { readonly: true, safeIntegers: true })
    expect(tableNames(b)).toEqual(tableNames(a))
    // Every row of every table, the rows the migrations seed included
    // (booleans both ways, nulls, numbers).
    for (const table of tableNames(a)) {
      expect({ table, rows: tableRows(b, table) }).toEqual({ table, rows: tableRows(a, table) })
    }
    const big = b.query<{ seq: bigint; updated_at: string }, []>("select seq, updated_at from collab_documents where doc_id = 'big'").get()
    expect(big).toEqual({ seq: 9007199254740993n, updated_at: '2026-03-04T05:06:07.089Z' })
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

  it('a failed import leaves Postgres as it was, and other tables are never touched', async () => {
    await wipePostgres(url)
    const good = await seededSqlite('good.db')
    await importSqliteIntoPostgres(url, good)
    const sql = new SQL(url)
    await sql.unsafe('create table not_instatic (id integer primary key)')
    await sql.unsafe('insert into not_instatic (id) values (7)')

    // A row that points at a folder that does not exist.
    const bad = await seededSqlite('bad.db')
    const raw = new Database(bad)
    raw.exec('PRAGMA foreign_keys = OFF')
    raw.exec("insert into media_folders (id, name, slug, parent_id) values ('orphan', 'Orphan', 'orphan', 'nowhere')")
    raw.close()
    await expect(importSqliteIntoPostgres(url, bad)).rejects.toThrow()

    const folders = await sql.unsafe<{ id: string }[]>('select id from media_folders order by id')
    expect(folders.map((row) => row.id)).toEqual(['child', 'parent'])
    // Another application's table keeps its rows through a good import too.
    await importSqliteIntoPostgres(url, good)
    const kept = await sql.unsafe<{ id: number }[]>('select id from not_instatic')
    expect(kept.map((row) => row.id)).toEqual([7])
    await sql.unsafe('drop table not_instatic')
    await sql.close()
  })

  it('a restore applied at boot keeps one undo copy of the old data, even when it runs twice', async () => {
    await wipePostgres(url)
    await importSqliteIntoPostgres(url, await seededSqlite('before.db'))
    const incoming = await seededSqlite('incoming.db')
    const raw = new Database(incoming)
    raw.exec("update site set name = 'Restored'")
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    raw.close()

    const managerDir = join(root, 'manager')
    const uploadsDir = join(root, 'uploads')
    await mkdir(managerDir, { recursive: true })
    await mkdir(uploadsDir, { recursive: true })
    const siteName = (file: string) => {
      const db = new Database(file, { readonly: true })
      const name = db.query<{ name: string }, []>('select name from site').get()?.name
      db.close()
      return name
    }
    const stage = async (marker: { undoCopyTaken?: boolean }) => {
      await copyFile(incoming, restoreStagingPath(managerDir))
      await writePendingRestore(managerDir, { kind: 'snapshot', createdAt: new Date().toISOString(), databaseApplied: false, ...marker })
    }

    await stage({})
    expect(await applyPendingRestore({ managerDir, databaseUrl: url, uploadsDir })).toEqual({ status: 'applied', kind: 'snapshot' })
    const sql = new SQL(url)
    expect((await sql.unsafe<{ name: string }[]>('select name from site'))[0]?.name).toBe('Restored')
    await sql.close()
    expect(siteName(postgresPreRestorePath(managerDir))).toBe('Bridge')

    // Killed after the import, before the marker recorded it: the next boot
    // imports again and must not replace the undo copy with restored data.
    await stage({ undoCopyTaken: true })
    expect((await applyPendingRestore({ managerDir, databaseUrl: url, uploadsDir })).status).toBe('applied')
    expect(siteName(postgresPreRestorePath(managerDir))).toBe('Bridge')
  })
})
