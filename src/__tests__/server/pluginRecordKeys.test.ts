/**
 * Plugin storage: unique keys, get-by-id and versioned updates.
 *
 * Plugin handlers interleave, so the repository has to make "create if
 * absent" and "update if unchanged" single statements the database decides.
 * The races here fire N calls at once against a real SQLite database; the
 * Postgres twin (two connection pools) is `pluginRecordKeysPostgres.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { DbClient } from '../../../server/db/client'
import { installPlugin } from '../../../server/repositories/plugins'
import {
  PluginRecordConflictError,
  PluginRecordDuplicateError,
  PLUGIN_RECORD_REKEY_LIMIT,
  PluginRecordRekeyError,
  createPluginRecord,
  createPluginRecordIfAbsent,
  deletePluginRecord,
  getPluginRecord,
  getPluginRecordByKey,
  listPluginRecords,
  pluginRecordRekeyProblem,
  rekeyPluginRecords,
  updatePluginRecord,
} from '../../../server/repositories/pluginRecords'
import { createTestDb } from '../helpers/createTestDb'

const PLUGIN = 'acme.shop'
const OTHER_PLUGIN = 'acme.other'
const events = { pluginId: PLUGIN, resourceId: 'events' }

function manifest(id: string) {
  return parsePluginManifest({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    permissions: ['cms.storage'],
    resources: [
      {
        id: 'events',
        title: 'Events',
        uniqueField: 'eventId',
        fields: [
          { id: 'eventId', label: 'Event id', type: 'text' },
          { id: 'state', label: 'State', type: 'text' },
        ],
      },
    ],
  })
}

let db: DbClient
let cleanup: () => Promise<void>
let nextId = 0
const newId = () => `rec_${++nextId}`

beforeEach(async () => {
  const testDb = await createTestDb()
  db = testDb.db
  cleanup = testDb.cleanup
  await installPlugin(db, manifest(PLUGIN))
  await installPlugin(db, manifest(OTHER_PLUGIN))
})

afterEach(async () => {
  await cleanup()
})

describe('plugin record unique keys', () => {
  it('creates exactly one record when many callers race on one key', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        createPluginRecordIfAbsent(db, {
          ...events,
          id: newId(),
          data: { eventId: 'evt_1', state: `caller ${index}` },
          uniqueKey: 'evt_1',
        }),
      ),
    )
    const created = results.filter((result) => result.created)
    expect(created).toHaveLength(1)
    // Everyone is handed the one stored record.
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1)
    const { totalCount } = await listPluginRecords(db, PLUGIN, 'events')
    expect(totalCount).toBe(1)
  })

  it('create rejects a taken key with a typed error and stores nothing', async () => {
    await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1' }, uniqueKey: 'evt_1' })
    const second = createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1' }, uniqueKey: 'evt_1' })
    expect(second).rejects.toBeInstanceOf(PluginRecordDuplicateError)
    await second.catch(() => {})
    expect((await listPluginRecords(db, PLUGIN, 'events')).totalCount).toBe(1)
  })

  it('keeps records without a key distinct from each other', async () => {
    await createPluginRecord(db, { ...events, id: newId(), data: { state: 'a' }, uniqueKey: null })
    await createPluginRecord(db, { ...events, id: newId(), data: { state: 'b' }, uniqueKey: null })
    expect((await listPluginRecords(db, PLUGIN, 'events')).totalCount).toBe(2)
  })

  it('scopes a key to one plugin and one resource', async () => {
    const mine = await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1' }, uniqueKey: 'evt_1' })
    // Same key, another plugin and another resource: no collision.
    const theirs = await createPluginRecord(db, {
      pluginId: OTHER_PLUGIN,
      resourceId: 'events',
      id: newId(),
      data: { eventId: 'evt_1' },
      uniqueKey: 'evt_1',
    })
    await createPluginRecord(db, { pluginId: PLUGIN, resourceId: 'orders', id: newId(), data: {}, uniqueKey: 'evt_1' })

    expect((await getPluginRecordByKey(db, events, 'evt_1'))?.id).toBe(mine.id)
    expect((await getPluginRecordByKey(db, { pluginId: OTHER_PLUGIN, resourceId: 'events' }, 'evt_1'))?.id).toBe(theirs.id)
    // A plugin cannot read another plugin's record by id either.
    expect(await getPluginRecord(db, { pluginId: OTHER_PLUGIN, resourceId: 'events' }, mine.id)).toBeNull()
    expect(await getPluginRecord(db, events, mine.id)).not.toBeNull()
  })

  it('treats a key as data, never as SQL', async () => {
    const hostile = `x' or '1'='1'; drop table plugin_records; --`
    await createPluginRecord(db, { ...events, id: newId(), data: { eventId: hostile }, uniqueKey: hostile })
    expect((await getPluginRecordByKey(db, events, hostile))?.uniqueKey).toBe(hostile)
    expect(await getPluginRecordByKey(db, events, `' or '1'='1`)).toBeNull()
  })

  it('reads a row written before the migration as version 0 with no key', async () => {
    // What 035 and earlier wrote: no unique_key, no version.
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('legacy', ${PLUGIN}, 'events', ${JSON.stringify({ state: 'old' })})
    `
    const legacy = await getPluginRecord(db, events, 'legacy')
    expect(legacy).toMatchObject({ uniqueKey: null, version: 0, data: { state: 'old' } })
  })
})

describe('plugin record versions', () => {
  it('lets exactly one of many writers holding the same version win', async () => {
    const record = await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1', state: 'new' }, uniqueKey: 'evt_1' })
    expect(record.version).toBe(0)

    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, (_, index) =>
        updatePluginRecord(db, {
          ...events,
          id: record.id,
          data: { eventId: 'evt_1', state: `writer ${index}` },
          uniqueKey: 'evt_1',
          ifVersion: 0,
        }),
      ),
    )
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(24)
    for (const outcome of lost) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(PluginRecordConflictError)
    }
    expect((await getPluginRecord(db, events, record.id))?.version).toBe(1)
  })

  it('bumps the version on every update, with or without ifVersion', async () => {
    const record = await createPluginRecord(db, { ...events, id: newId(), data: { state: 'a' }, uniqueKey: null })
    const first = await updatePluginRecord(db, { ...events, id: record.id, data: { state: 'b' }, uniqueKey: null })
    const second = await updatePluginRecord(db, { ...events, id: record.id, data: { state: 'c' }, uniqueKey: null, ifVersion: 1 })
    expect(first?.version).toBe(1)
    expect(second?.version).toBe(2)
    expect(second?.data).toEqual({ state: 'c' })
  })

  it('answers null for a missing record even with ifVersion', async () => {
    expect(await updatePluginRecord(db, { ...events, id: 'nope', data: {}, uniqueKey: null, ifVersion: 3 })).toBeNull()
    expect(await deletePluginRecord(db, { ...events, id: 'nope', ifVersion: 3 })).toBe(false)
  })

  it('rejects an update that would take another record\'s key', async () => {
    await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1' }, uniqueKey: 'evt_1' })
    const other = await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_2' }, uniqueKey: 'evt_2' })
    const clash = updatePluginRecord(db, { ...events, id: other.id, data: { eventId: 'evt_1' }, uniqueKey: 'evt_1' })
    expect(clash).rejects.toBeInstanceOf(PluginRecordDuplicateError)
    await clash.catch(() => {})
    expect((await getPluginRecord(db, events, other.id))?.uniqueKey).toBe('evt_2')
  })

  it('deletes only while the version still matches', async () => {
    const record = await createPluginRecord(db, { ...events, id: newId(), data: { state: 'a' }, uniqueKey: null })
    await updatePluginRecord(db, { ...events, id: record.id, data: { state: 'b' }, uniqueKey: null })
    const stale = deletePluginRecord(db, { ...events, id: record.id, ifVersion: 0 })
    expect(stale).rejects.toBeInstanceOf(PluginRecordConflictError)
    await stale.catch(() => {})
    expect(await deletePluginRecord(db, { ...events, id: record.id, ifVersion: 1 })).toBe(true)
    expect(await getPluginRecord(db, events, record.id)).toBeNull()
  })
})

describe('re-keying a resource', () => {
  it('rebuilds keys from the new unique field and clears them when it goes away', async () => {
    const a = await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1', state: 'x' }, uniqueKey: 'evt_1' })
    const b = await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_2', state: 'y' }, uniqueKey: 'evt_2' })

    await db.transaction((tx) => rekeyPluginRecords(tx, events, 'state', { capped: true }))
    expect((await getPluginRecordByKey(db, events, 'x'))?.id).toBe(a.id)
    expect((await getPluginRecordByKey(db, events, 'y'))?.id).toBe(b.id)
    expect(await getPluginRecordByKey(db, events, 'evt_1')).toBeNull()
    // The data did not change, so neither did the version.
    expect((await getPluginRecord(db, events, a.id))?.version).toBe(0)

    await db.transaction((tx) => rekeyPluginRecords(tx, events, undefined, { capped: true }))
    expect((await getPluginRecord(db, events, a.id))?.uniqueKey).toBeNull()
  })

  it('names the collision and leaves the old keys in place', async () => {
    await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_1', state: 'same' }, uniqueKey: 'evt_1' })
    await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_2', state: 'same' }, uniqueKey: 'evt_2' })

    expect(await pluginRecordRekeyProblem(db, events, 'state', { capped: true })).toContain('share the "state" value "same"')
    expect(await pluginRecordRekeyProblem(db, events, 'eventId', { capped: true })).toBeNull()

    const rekey = db.transaction((tx) => rekeyPluginRecords(tx, events, 'state', { capped: true }))
    expect(rekey).rejects.toBeInstanceOf(PluginRecordRekeyError)
    await rekey.catch(() => {})
    // The caller's transaction rolled back: the previous keys still resolve.
    expect(await getPluginRecordByKey(db, events, 'evt_1')).not.toBeNull()
  })

  it('derives keys exactly as a write does: trimmed, otherwise untouched', async () => {
    // Stored before the resource had a unique field, straight into the table.
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('padded', ${PLUGIN}, 'events', ${{ eventId: '  evt_padded  ', state: 'x' }})
    `
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('blank', ${PLUGIN}, 'events', ${{ eventId: '   ', state: 'y' }})
    `
    await db.transaction((tx) => rekeyPluginRecords(tx, events, 'eventId', { capped: true }))
    expect((await getPluginRecord(db, events, 'padded'))?.uniqueKey).toBe('evt_padded')
    // Blank after trimming: no key, like a write.
    expect((await getPluginRecord(db, events, 'blank'))?.uniqueKey).toBeNull()
    // Case is part of the key.
    expect(await getPluginRecordByKey(db, events, 'EVT_PADDED')).toBeNull()

    // A value that only differs by surrounding whitespace now collides.
    await createPluginRecord(db, { ...events, id: newId(), data: { eventId: 'evt_x', state: 'a' }, uniqueKey: 'evt_x' })
    await db`
      insert into plugin_records (id, plugin_id, resource_id, data_json)
      values ('padded_twin', ${PLUGIN}, 'events', ${{ eventId: ' evt_x ', state: 'b' }})
    `
    expect(await pluginRecordRekeyProblem(db, events, 'eventId', { capped: true })).toContain('share the "eventId" value "evt_x"')
  })

  it('caps a change of unique field by record count, but never a restore', async () => {
    const big = { pluginId: PLUGIN, resourceId: 'big' }
    // One over the limit, written in a single statement.
    await db.unsafe(
      `with recursive n(i) as (select 1 union all select i + 1 from n where i <= ?)
       insert into plugin_records (id, plugin_id, resource_id, data_json)
       select 'big_' || printf('%06d', i), ?, 'big', json_object('eventId', 'evt_' || i) from n`,
      [PLUGIN_RECORD_REKEY_LIMIT, PLUGIN],
    )
    expect((await listPluginRecords(db, PLUGIN, 'big', { limit: 1 })).totalCount).toBe(PLUGIN_RECORD_REKEY_LIMIT + 1)

    expect(await pluginRecordRekeyProblem(db, big, 'eventId', { capped: true })).toContain('more than 50000 records')
    const capped = db.transaction((tx) => rekeyPluginRecords(tx, big, 'eventId', { capped: true }))
    expect(capped).rejects.toBeInstanceOf(PluginRecordRekeyError)
    await capped.catch(() => {})

    // A rollback restores keys that were valid before: size must not stop it.
    expect(await pluginRecordRekeyProblem(db, big, 'eventId', { capped: false })).toBeNull()
    await db.transaction((tx) => rekeyPluginRecords(tx, big, 'eventId', { capped: false }))
    expect((await getPluginRecordByKey(db, big, 'evt_1'))?.id).toBe('big_000001')
    expect((await getPluginRecordByKey(db, big, `evt_${PLUGIN_RECORD_REKEY_LIMIT + 1}`))?.id).toBe(
      `big_${String(PLUGIN_RECORD_REKEY_LIMIT + 1).padStart(6, '0')}`,
    )
  }, 120_000)
})
