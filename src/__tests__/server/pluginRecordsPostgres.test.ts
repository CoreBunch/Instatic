/**
 * Plugin record storage on Postgres. Runs when `INSTATIC_TEST_POSTGRES_URL`
 * names a database the tests may wipe, as CI's test job does
 * (`.github/workflows/ci.yml`). Locally:
 *
 *   initdb -D /tmp/pg -U postgres -A trust
 *   pg_ctl -D /tmp/pg -o "-p 55439 -c unix_socket_directories=''" start
 *   psql -h 127.0.0.1 -p 55439 -U postgres -c 'create database records'
 *   INSTATIC_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55439/records \
 *     bun test src/__tests__/server/pluginRecordsPostgres.test.ts
 *
 * Three things only Postgres can get wrong: record data stored as a JSON
 * string scalar instead of an object, the migration that repairs the rows
 * written that way, and `list` comparing a text extraction with a number.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { createDbClient } from '../../../server/db'
import type { DbClient } from '../../../server/db/client'
import { PLUGIN_RECORDS_JSON_REPAIR_SQL } from '../../../server/db/migrations-pg'
import type { Migration } from '../../../server/db/runMigrations'
import { runMigrations } from '../../../server/db/runMigrations'
import { installPlugin } from '../../../server/repositories/plugins'
import {
  createPluginRecord,
  listPluginRecords,
  updatePluginRecord,
} from '../../../server/repositories/pluginRecords'
import {
  PLUGIN_RECORD_FILTER_CASES,
  expectPluginRecordFilterCase,
  seedPluginRecordFilterCases,
} from '../helpers/pluginRecordFilterCases'

const url = process.env.INSTATIC_TEST_POSTGRES_URL
const PLUGIN = 'acme.pgrecords'
const cases = { pluginId: PLUGIN, resourceId: 'cases' }
const REPAIR_MIGRATION = '036_plugin_records_json_repair'

describe.skipIf(!url)('plugin record storage on Postgres', () => {
  let db: DbClient
  let migrations: Migration[]

  async function storedKind(id: string): Promise<string | undefined> {
    const { rows } = await db.unsafe<{ kind: string }>(
      `select jsonb_typeof(data_json) as kind from plugin_records where id = $1`,
      [id],
    )
    return rows[0]?.kind
  }

  beforeAll(async () => {
    const client = createDbClient(url ?? '')
    db = client.db
    migrations = client.migrations
    await runMigrations(db, migrations)
    await db`delete from installed_plugins where id = ${PLUGIN}`
    await installPlugin(
      db,
      parsePluginManifest({ id: PLUGIN, name: 'Records', version: '1.0.0', apiVersion: 1, permissions: ['cms.storage'] }),
    )
    await seedPluginRecordFilterCases(db, cases)
  })

  afterAll(async () => {
    await db`delete from installed_plugins where id = ${PLUGIN}`
    await db.close()
  })

  describe('filters and ordering', () => {
    for (const testCase of PLUGIN_RECORD_FILTER_CASES) {
      it(testCase.name, async () => {
        await expectPluginRecordFilterCase(db, cases, testCase)
      })
    }
  })

  it('stores data as a JSON object on create and on update', async () => {
    const scope = { pluginId: PLUGIN, resourceId: 'binding' }
    await createPluginRecord(db, { ...scope, id: 'bind_1', data: { state: 'new', n: 1 } })
    expect(await storedKind('bind_1')).toBe('object')
    expect((await listPluginRecords(db, PLUGIN, 'binding', { filter: { state: 'new' } })).totalCount).toBe(1)

    await updatePluginRecord(db, { ...scope, id: 'bind_1', data: { state: 'paid', n: 2 } })
    expect(await storedKind('bind_1')).toBe('object')
    expect((await listPluginRecords(db, PLUGIN, 'binding', { filter: { state: 'paid', n: 2 } })).totalCount).toBe(1)
  })

  it('refuses the NUL character, as SQLite does', async () => {
    const create = createPluginRecord(db, { pluginId: PLUGIN, resourceId: 'binding', id: 'nul', data: { body: 'a\u0000b' } })
    expect(create).rejects.toThrow('cannot contain the NUL character')
    await create.catch(() => {})
  })

  it('the repair migration unwraps string-stored rows and leaves the rest alone', async () => {
    // What every write produced before the fix: a stringified object bound to
    // the jsonb column, stored as a string scalar no filter can see.
    const legacy = (id: string, raw: string) => db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values (${id}, ${PLUGIN}, 'legacy', ${raw})
    `
    await legacy('legacy_ok', JSON.stringify({ eventId: 'evt_legacy', n: 7 }))
    await legacy('legacy_broken', '{not json')
    await legacy('legacy_plain', 'just a sentence')
    await legacy('legacy_array', '[1,2]')
    await createPluginRecord(db, { pluginId: PLUGIN, resourceId: 'legacy', id: 'modern', data: { eventId: 'evt_modern' } })
    expect(await storedKind('legacy_ok')).toBe('string')
    expect((await listPluginRecords(db, PLUGIN, 'legacy', { filter: { eventId: 'evt_legacy' } })).totalCount).toBe(0)

    // Run it the way a server start does: through the migration runner.
    await db`delete from schema_migrations where id = ${REPAIR_MIGRATION}`
    await runMigrations(db, migrations)

    expect(await storedKind('legacy_ok')).toBe('object')
    const repaired = await listPluginRecords(db, PLUGIN, 'legacy', { filter: { eventId: 'evt_legacy', n: 7 } })
    expect(repaired.records.map((record) => record.id)).toEqual(['legacy_ok'])
    // Not an object, or not JSON at all: left exactly as it was.
    expect(await storedKind('legacy_broken')).toBe('string')
    expect(await storedKind('legacy_plain')).toBe('string')
    expect(await storedKind('legacy_array')).toBe('string')
    expect(await storedKind('modern')).toBe('object')

    // The rows it could not unwrap read as empty; they do not break the list.
    const all = await listPluginRecords(db, PLUGIN, 'legacy')
    expect(all.totalCount).toBe(5)
    const byId = new Map(all.records.map((record) => [record.id, record]))
    expect(byId.get('legacy_broken')).toMatchObject({ data: {}, unreadable: true })
    expect(byId.get('legacy_array')).toMatchObject({ data: {}, unreadable: true })
    expect(byId.get('legacy_ok')?.data).toEqual({ eventId: 'evt_legacy', n: 7 })
  })

  it('a row that makes the fast path raise cannot fail the migration', async () => {
    // pg_input_is_valid only reports soft errors: JSON nested this deep raises
    // "stack depth limit exceeded" instead. Before, that aborted the migration
    // and with it every boot.
    const poison = `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`
    const legacy = (id: string, raw: string) => db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values (${id}, ${PLUGIN}, 'poison', ${raw})
    `
    await legacy('poison_row', poison)
    await legacy('poison_neighbour', JSON.stringify({ eventId: 'evt_neighbour' }))

    await db`delete from schema_migrations where id = ${REPAIR_MIGRATION}`
    await runMigrations(db, migrations)

    const applied = await db<{ id: string }>`select id from schema_migrations where id = ${REPAIR_MIGRATION}`
    expect(applied.rows).toHaveLength(1)
    expect(await storedKind('poison_neighbour')).toBe('object')
    expect(await storedKind('poison_row')).toBe('string')
    // The list still works; the row nested too deep to handle is marked, not fatal.
    const listed = await listPluginRecords(db, PLUGIN, 'poison')
    const byId = new Map(listed.records.map((record) => [record.id, record]))
    expect(byId.get('poison_neighbour')?.data).toEqual({ eventId: 'evt_neighbour' })
    expect(byId.get('poison_row')).toMatchObject({ data: {}, unreadable: true })
    await db`delete from plugin_records where id = 'poison_row'`
  }, 60_000)

  it('a statement timeout shorter than the repair cannot fail the migration', async () => {
    // plpgsql cannot catch a cancel, so a database or role statement_timeout
    // used to abort the migration on every boot. New connections to this
    // database get a 100 ms limit; the repair of 150,000 rows takes far longer.
    await db.unsafe(
      `insert into plugin_records (id, plugin_id, resource_id, data_json)
       select 'slow_' || g, $1, 'slow', to_jsonb(json_build_object('eventId', 'evt_' || g, 'pad', repeat('x', 200))::text)
         from generate_series(1, 150000) g`,
      [PLUGIN],
    )
    const { rows } = await db<{ name: string }>`select current_database() as name`
    const database = `"${rows[0]?.name.replaceAll('"', '""')}"`
    await db`delete from schema_migrations where id = ${REPAIR_MIGRATION}`
    await db.unsafe(`alter database ${database} set statement_timeout = '100ms'`)
    const timed = createDbClient(url ?? '')
    try {
      const limit = await timed.db<{ value: string }>`select current_setting('statement_timeout') as value`
      expect(limit.rows[0]?.value).toBe('100ms')
      await runMigrations(timed.db, timed.migrations)
    } finally {
      await timed.db.close()
      await db.unsafe(`alter database ${database} reset statement_timeout`)
    }

    const applied = await db<{ id: string }>`select id from schema_migrations where id = ${REPAIR_MIGRATION}`
    expect(applied.rows).toHaveLength(1)
    const left = await db.unsafe<{ kind: string; total: string }>(
      `select jsonb_typeof(data_json) as kind, count(*) as total from plugin_records
        where plugin_id = $1 and resource_id = 'slow' group by 1`,
      [PLUGIN],
    )
    expect(left.rows.map((row) => [row.kind, Number(row.total)])).toEqual([['object', 150000]])
    await db`delete from plugin_records where plugin_id = ${PLUGIN} and resource_id = 'slow'`
  }, 120_000)

  it('says in the server log how many rows the repair left as text', async () => {
    // Text rows other tests left behind would be counted too.
    await db.unsafe(`delete from plugin_records where jsonb_typeof(data_json) = 'string'`)
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('left_text', ${PLUGIN}, 'leftover', ${'{"eventId": broken'})
    `
    await db`delete from schema_migrations where id = ${REPAIR_MIGRATION}`
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runMigrations(db, migrations)
      const lines = warn.mock.calls.map((call) => String(call[0]))
      expect(lines.filter((line) => line.startsWith(`[migrations] ${REPAIR_MIGRATION}:`))).toEqual([
        `[migrations] ${REPAIR_MIGRATION}: 1 plugin record(s) are still stored as text. They can be read where the text holds a JSON object, but list filters do not match them until each is saved again.`,
      ])
      warn.mockClear()
      // Nothing left: the migration is quiet.
      await db`delete from plugin_records where id = 'left_text'`
      await db`delete from schema_migrations where id = ${REPAIR_MIGRATION}`
      await runMigrations(db, migrations)
      expect(warn.mock.calls.filter((call) => String(call[0]).startsWith('[migrations]'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('the row path, for servers without pg_input_is_valid, repairs the same rows', async () => {
    const legacy = (id: string, raw: string) => db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values (${id}, ${PLUGIN}, 'older', ${raw})
    `
    await legacy('older_ok', JSON.stringify({ eventId: 'evt_older' }))
    await legacy('older_broken', '{"unterminated": ')

    // Same migration text, asking for a function no server has, so the block
    // takes the path Postgres 15 and older take.
    const rowPath = PLUGIN_RECORDS_JSON_REPAIR_SQL.replace(
      "to_regprocedure('pg_input_is_valid(text, text)')",
      "to_regprocedure('pg_input_is_valid_absent(text, text)')",
    )
    expect(rowPath).not.toBe(PLUGIN_RECORDS_JSON_REPAIR_SQL)
    await db.unsafe(rowPath)

    expect(await storedKind('older_ok')).toBe('object')
    expect(await storedKind('older_broken')).toBe('string')
    expect((await listPluginRecords(db, PLUGIN, 'older', { filter: { eventId: 'evt_older' } })).totalCount).toBe(1)
  })

  it('reads and updates a row still in the legacy string form', async () => {
    // A string holding an object that the repair did not reach (written by an
    // older instance during a rolling deploy, say) is not damaged.
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('still_string', ${PLUGIN}, 'stragglers', ${JSON.stringify({ state: 'old' })})
    `
    expect(await storedKind('still_string')).toBe('string')
    const listed = await listPluginRecords(db, PLUGIN, 'stragglers')
    expect(listed.records[0]).toMatchObject({ id: 'still_string', data: { state: 'old' } })
    expect(listed.records[0]?.unreadable).toBeUndefined()

    const updated = await updatePluginRecord(db, {
      pluginId: PLUGIN,
      resourceId: 'stragglers',
      id: 'still_string',
      data: { state: 'new' },
    })
    expect(updated?.data).toEqual({ state: 'new' })
    expect(await storedKind('still_string')).toBe('object')
  })

  it('refuses an unpaired surrogate with the same error as SQLite', async () => {
    const lone = createPluginRecord(db, { pluginId: PLUGIN, resourceId: 'binding', id: 'sur', data: { body: 'a\ud800b' } })
    expect(lone).rejects.toThrow('unpaired surrogate')
    await lone.catch(() => {})
  })
})
