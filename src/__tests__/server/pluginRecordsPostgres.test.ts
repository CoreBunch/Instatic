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
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
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
    const byId = new Map(all.records.map((record) => [record.id, record.data]))
    expect(byId.get('legacy_broken')).toEqual({})
    expect(byId.get('legacy_array')).toEqual({})
    expect(byId.get('legacy_ok')).toEqual({ eventId: 'evt_legacy', n: 7 })
  })

  it('the path for servers older than Postgres 16 repairs the same rows', async () => {
    const legacy = (id: string, raw: string) => db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values (${id}, ${PLUGIN}, 'older', ${raw})
    `
    await legacy('older_ok', JSON.stringify({ eventId: 'evt_older' }))
    await legacy('older_broken', '{"unterminated": ')

    // Same migration text with the version test made unreachable, so the
    // branch without pg_input_is_valid runs on whatever server this is.
    const olderPath = PLUGIN_RECORDS_JSON_REPAIR_SQL.replace('>= 160000', '>= 990000')
    expect(olderPath).not.toBe(PLUGIN_RECORDS_JSON_REPAIR_SQL)
    await db.unsafe(olderPath)

    expect(await storedKind('older_ok')).toBe('object')
    expect(await storedKind('older_broken')).toBe('string')
    expect((await listPluginRecords(db, PLUGIN, 'older', { filter: { eventId: 'evt_older' } })).totalCount).toBe(1)
  })
})
