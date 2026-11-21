/**
 * Plugin storage on Postgres, across two connection pools, as two server
 * instances have (each instance runs its own worker for a plugin, so two
 * deliveries of one webhook can land on different instances). Runs when
 * `INSTATIC_TEST_POSTGRES_URL` names a database the tests may wipe, as CI's
 * test job does (`.github/workflows/ci.yml`). Locally:
 *
 *   initdb -D /tmp/pg -U postgres -A trust
 *   pg_ctl -D /tmp/pg -o "-p 55439 -c unix_socket_directories=''" start
 *   psql -h 127.0.0.1 -p 55439 -U postgres -c 'create database records'
 *   INSTATIC_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55439/records \
 *     bun test src/__tests__/server/pluginRecordKeysPostgres.test.ts
 *
 * No lock is taken between instances: the unique index and the version
 * comparison inside each statement are the only coordination. This is the
 * test that they are enough.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parsePluginManifest } from '@core/plugins/manifest'
import { createDbClient } from '../../../server/db'
import type { DbClient } from '../../../server/db/client'
import { runMigrations } from '../../../server/db/runMigrations'
import { installPlugin } from '../../../server/repositories/plugins'
import {
  PluginRecordConflictError,
  PluginRecordDuplicateError,
  createPluginRecord,
  createPluginRecordIfAbsent,
  getPluginRecord,
  getPluginRecordByKey,
  listPluginRecords,
  updatePluginRecord,
} from '../../../server/repositories/pluginRecords'

const url = process.env.INSTATIC_TEST_POSTGRES_URL
const PLUGIN = 'acme.pgshop'
const events = { pluginId: PLUGIN, resourceId: 'events' }

describe.skipIf(!url)('plugin storage on Postgres, two instances', () => {
  let first: DbClient
  let second: DbClient
  let nextId = 0
  const newId = () => `pg_rec_${++nextId}`

  beforeAll(async () => {
    const a = createDbClient(url ?? '')
    const b = createDbClient(url ?? '')
    first = a.db
    second = b.db
    await runMigrations(first, a.migrations)
    await first`delete from installed_plugins where id = ${PLUGIN}`
    await installPlugin(
      first,
      parsePluginManifest({
        id: PLUGIN,
        name: 'Shop',
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
      }),
    )
  })

  afterAll(async () => {
    await first`delete from installed_plugins where id = ${PLUGIN}`
    await first.close()
    await second.close()
  })

  it('creates exactly one record when both instances race on one key', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        createPluginRecordIfAbsent(index % 2 === 0 ? first : second, {
          ...events,
          id: newId(),
          data: { eventId: 'evt_race', state: `caller ${index}` },
          uniqueKey: 'evt_race',
        }),
      ),
    )
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.record.id)).size).toBe(1)
    const stored = await listPluginRecords(first, PLUGIN, 'events', { filter: { eventId: 'evt_race' } })
    expect(stored.totalCount).toBe(1)
  })

  it('lets exactly one writer holding the same version win across instances', async () => {
    const record = await createPluginRecord(first, {
      ...events,
      id: newId(),
      data: { eventId: 'evt_version', state: 'new' },
      uniqueKey: 'evt_version',
    })
    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) =>
        updatePluginRecord(index % 2 === 0 ? first : second, {
          ...events,
          id: record.id,
          data: { eventId: 'evt_version', state: `writer ${index}` },
          uniqueKey: 'evt_version',
          ifVersion: 0,
        }),
      ),
    )
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(lost).toHaveLength(39)
    for (const outcome of lost) {
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(PluginRecordConflictError)
    }
    expect((await getPluginRecord(second, events, record.id))?.version).toBe(1)
  })

  it('rejects duplicate creates and key-stealing updates with the typed error', async () => {
    await createPluginRecord(first, { ...events, id: newId(), data: { eventId: 'evt_a' }, uniqueKey: 'evt_a' })
    const other = await createPluginRecord(first, { ...events, id: newId(), data: { eventId: 'evt_b' }, uniqueKey: 'evt_b' })

    const duplicate = createPluginRecord(second, { ...events, id: newId(), data: { eventId: 'evt_a' }, uniqueKey: 'evt_a' })
    expect(duplicate).rejects.toBeInstanceOf(PluginRecordDuplicateError)
    await duplicate.catch(() => {})

    const steal = updatePluginRecord(second, { ...events, id: other.id, data: { eventId: 'evt_a' }, uniqueKey: 'evt_a' })
    expect(steal).rejects.toBeInstanceOf(PluginRecordDuplicateError)
    await steal.catch(() => {})
    expect((await getPluginRecordByKey(first, events, 'evt_b'))?.id).toBe(other.id)
  })

  it('keeps records without a key distinct', async () => {
    await createPluginRecord(first, { ...events, id: newId(), data: { state: 'a' }, uniqueKey: null })
    await createPluginRecord(second, { ...events, id: newId(), data: { state: 'b' }, uniqueKey: null })
    const stored = await listPluginRecords(first, PLUGIN, 'events', { filter: { state: { in: ['a', 'b'] } } })
    expect(stored.totalCount).toBe(2)
  })
})
