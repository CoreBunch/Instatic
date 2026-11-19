/**
 * Plugin record storage on SQLite: what `list` filters and ordering mean,
 * what data is refused, and how a damaged row reads. The Postgres twin, with
 * the same filter table, is `pluginRecordsPostgres.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { DbClient } from '../../../server/db/client'
import { installPlugin } from '../../../server/repositories/plugins'
import {
  PluginRecordUnreadableError,
  createPluginRecord,
  deletePluginRecord,
  listPluginRecords,
  updatePluginRecord,
} from '../../../server/repositories/pluginRecords'
import { createTestDb } from '../helpers/createTestDb'
import {
  PLUGIN_RECORD_FILTER_CASES,
  expectPluginRecordFilterCase,
  seedPluginRecordFilterCases,
} from '../helpers/pluginRecordFilterCases'

const PLUGIN = 'acme.records'
const cases = { pluginId: PLUGIN, resourceId: 'cases' }
const notes = { pluginId: PLUGIN, resourceId: 'notes' }

let db: DbClient
let cleanup: () => Promise<void>

beforeAll(async () => {
  const testDb = await createTestDb()
  db = testDb.db
  cleanup = testDb.cleanup
  await installPlugin(
    db,
    parsePluginManifest({ id: PLUGIN, name: 'Records', version: '1.0.0', apiVersion: 1, permissions: ['cms.storage'] }),
  )
  await seedPluginRecordFilterCases(db, cases)
})

afterAll(async () => {
  await cleanup()
})

describe('plugin record filters and ordering (SQLite)', () => {
  for (const testCase of PLUGIN_RECORD_FILTER_CASES) {
    it(testCase.name, async () => {
      await expectPluginRecordFilterCase(db, cases, testCase)
    })
  }

  it('refuses a comparison with something that is not a scalar', async () => {
    const list = listPluginRecords(db, PLUGIN, 'cases', { filter: { n: { eq: { nested: 1 } } } })
    expect(list).rejects.toThrow('must compare with a string, number, boolean or null')
    await list.catch(() => {})
    const ordered = listPluginRecords(db, PLUGIN, 'cases', { filter: { n: { gt: null } } })
    expect(ordered).rejects.toThrow('null can only be used with eq and ne')
    await ordered.catch(() => {})
  })
})

describe('plugin record data', () => {
  it('refuses the NUL character anywhere in the data, on create and update', async () => {
    const create = createPluginRecord(db, { ...notes, id: 'nul_1', data: { body: 'a\u0000b' } })
    expect(create).rejects.toThrow('cannot contain the NUL character')
    await create.catch(() => {})
    const nested = createPluginRecord(db, { ...notes, id: 'nul_2', data: { list: [{ 'k\u0000': 1 }] } })
    expect(nested).rejects.toThrow('cannot contain the NUL character')
    await nested.catch(() => {})

    await createPluginRecord(db, { ...notes, id: 'nul_3', data: { body: 'fine' } })
    const update = updatePluginRecord(db, { ...notes, id: 'nul_3', data: { body: '\u0000' } })
    expect(update).rejects.toThrow('cannot contain the NUL character')
    await update.catch(() => {})
    const stored = await listPluginRecords(db, PLUGIN, 'notes', { filter: { body: 'fine' } })
    expect(stored.records.map((record) => record.id)).toEqual(['nul_3'])
  })

  it('refuses an unpaired surrogate, which Postgres cannot store either', async () => {
    const lone = createPluginRecord(db, { ...notes, id: 'sur_1', data: { body: 'a\ud800b' } })
    expect(lone).rejects.toThrow('unpaired surrogate')
    await lone.catch(() => {})
    const key = createPluginRecord(db, { ...notes, id: 'sur_2', data: { ['k\udc00']: 1 } })
    expect(key).rejects.toThrow('unpaired surrogate')
    await key.catch(() => {})
    // A real pair (an emoji) is fine.
    const paired = await createPluginRecord(db, { ...notes, id: 'sur_3', data: { body: 'ok \ud83d\ude00' } })
    expect(paired.data).toEqual({ body: 'ok \ud83d\ude00' })
  })

  it('refuses data nested deeper than a record may be, and marks a stored row that is', async () => {
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let level = 0; level < 600; level++) {
      const next: Record<string, unknown> = {}
      deep.a = next
      deep = next
    }
    const create = createPluginRecord(db, { ...notes, id: 'deep_1', data: root })
    expect(create).rejects.toThrow('cannot nest deeper than 512 levels')
    await create.catch(() => {})

    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('deep_stored', ${PLUGIN}, 'deep', ${`${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`})
    `
    const listed = await listPluginRecords(db, PLUGIN, 'deep')
    expect(listed.records[0]?.unreadable).toBe(true)
    expect(listed.records[0]?.data).toEqual({})
    // Brackets inside strings are text, not nesting.
    const braces = await createPluginRecord(db, { ...notes, id: 'braces', data: { body: '{['.repeat(2_000) } })
    expect(braces.unreadable).toBeUndefined()
    expect((await listPluginRecords(db, PLUGIN, 'notes', { filter: { body: { like: '{[%' } } })).totalCount).toBe(1)
  })

  it('marks a row whose data is not a JSON object as unreadable instead of failing the list', async () => {
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('odd_text', ${PLUGIN}, 'odd', ${'{not json'})
    `
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('odd_array', ${PLUGIN}, 'odd', ${'[1,2]'})
    `
    await createPluginRecord(db, { pluginId: PLUGIN, resourceId: 'odd', id: 'odd_fine', data: { ok: true } })

    const listed = await listPluginRecords(db, PLUGIN, 'odd')
    expect(listed.totalCount).toBe(3)
    const byId = new Map(listed.records.map((record) => [record.id, record]))
    expect(byId.get('odd_text')).toMatchObject({ data: {}, unreadable: true })
    expect(byId.get('odd_array')).toMatchObject({ data: {}, unreadable: true })
    expect(byId.get('odd_fine')?.data).toEqual({ ok: true })
    expect(byId.get('odd_fine')?.unreadable).toBeUndefined()
  })

  it('refuses to overwrite an unreadable row, and still lets it be deleted', async () => {
    const odd = { pluginId: PLUGIN, resourceId: 'odd' }
    const overwrite = updatePluginRecord(db, { ...odd, id: 'odd_text', data: { ok: false } })
    expect(overwrite).rejects.toBeInstanceOf(PluginRecordUnreadableError)
    await overwrite.catch(() => {})
    // Untouched: still what it was.
    const { rows } = await db<{ data_json: unknown }>`select data_json from plugin_records where id = 'odd_text'`
    expect(rows[0]?.data_json).toBe('{not json')

    expect((await updatePluginRecord(db, { ...odd, id: 'odd_fine', data: { ok: false } }))?.data).toEqual({ ok: false })
    expect(await updatePluginRecord(db, { ...odd, id: 'missing', data: {} })).toBeNull()
    expect(await deletePluginRecord(db, { ...odd, id: 'odd_text' })).toBe(true)
  })
})
