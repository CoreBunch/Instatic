/**
 * Plugin storage through a REAL plugin worker and a real database.
 *
 * The worker, VM, message protocol, api dispatcher and repository are the
 * production ones; only the database is a throwaway SQLite file. This is the
 * test that what a plugin author writes (`createIfAbsent`, `getByKey`,
 * `update(..., { ifVersion })`) behaves as documented from inside the sandbox,
 * including when several of the plugin's own route calls are in flight at once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { PluginManifest } from '@core/plugin-sdk'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import { loadPluginInWorker, runLifecycleInWorker, runRouteInWorker } from '../../../server/plugins/host/rpc'
import { resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { installPlugin } from '../../../server/repositories/plugins'
import { listPluginRecords } from '../../../server/repositories/pluginRecords'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const PLUGIN_ID = 'acme.ledger'

const SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  function message(promise) {
    return promise.then(function () { return 'resolved'; }, function (e) { return e.message; });
  }
  __plugin_exports.activate = async function activate(api) {
    const events = api.cms.storage.collection('events');
    const notes = api.cms.storage.collection('notes');

    // One webhook delivery: claim the event id, do the work only if we won.
    api.cms.routes.public.get('/claim', async function () {
      const claim = await events.createIfAbsent({ eventId: 'evt_webhook', state: 'received' });
      return { created: claim.created, id: claim.record.id, version: claim.record.version };
    });

    api.cms.routes.public.get('/burst', async function () {
      const claims = await Promise.all([1, 2, 3, 4, 5, 6].map(function () {
        return events.createIfAbsent({ eventId: 'evt_burst', state: 'received' });
      }));
      return {
        created: claims.filter(function (c) { return c.created; }).length,
        ids: claims.map(function (c) { return c.record.id; }),
      };
    });

    api.cms.routes.public.get('/duplicate', async function () {
      await events.create({ eventId: 'evt_dup', state: 'a' });
      return { second: await message(events.create({ eventId: 'evt_dup', state: 'b' })) };
    });

    api.cms.routes.public.get('/versions', async function () {
      const made = await events.create({ eventId: 'evt_versions', state: 'new' });
      const first = await events.update(made.id, { eventId: 'evt_versions', state: 'paid' }, { ifVersion: made.version });
      const stale = await message(events.update(made.id, { eventId: 'evt_versions', state: 'refunded' }, { ifVersion: made.version }));
      const read = await events.get(made.id);
      const byKey = await events.getByKey('  evt_versions ');
      const staleDelete = await message(events.delete(made.id, { ifVersion: 0 }));
      const deleted = await events.delete(made.id, { ifVersion: read.version });
      return {
        madeVersion: made.version,
        madeKey: made.uniqueKey,
        firstVersion: first.version,
        stale: stale,
        state: read.state || read.data.state,
        sameRecord: byKey.id === made.id,
        staleDelete: staleDelete,
        deleted: deleted,
        afterDeleteIsNull: (await events.get(made.id)) === null,
        blankKeyIsNull: (await events.getByKey('   ')) === null,
        missingIsNull: (await events.getByKey('evt_never')) === null,
      };
    });

    api.cms.routes.public.get('/no-unique-field', async function () {
      return {
        createIfAbsent: await message(notes.createIfAbsent({ body: 'x' })),
        getByKey: await message(notes.getByKey('x')),
        missingValue: await message(events.createIfAbsent({ state: 'no id' })),
      };
    });
  };
})();
`

let manifest: PluginManifest
let testDb: TestDb
let dir = ''

function get(path: string): Promise<Response> {
  return runRouteInWorker({
    pluginId: PLUGIN_ID,
    method: 'GET',
    path,
    request: new Request(`https://site.example/_instatic/plugins/${PLUGIN_ID}${path}`),
    user: null,
    member: null,
  })
}

beforeAll(async () => {
  testDb = await createTestDb()
  dir = await mkdtemp(join(tmpdir(), 'instatic-storage-'))
  await writeFile(join(dir, 'index.js'), SOURCE)
  manifest = {
    ...parsePluginManifest({
      id: PLUGIN_ID,
      name: 'Ledger',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['cms.routes', 'cms.routes.public', 'cms.storage'],
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
        { id: 'notes', title: 'Notes', fields: [{ id: 'body', label: 'Body', type: 'text' }] },
      ],
    }),
    grantedPermissions: ['cms.routes', 'cms.routes.public', 'cms.storage'],
  }
  await installPlugin(testDb.db, manifest)
  setPluginHostContext({ db: testDb.db, uploadsDir: dir })
  setApiCallDispatcher(dispatchApiCall)
  const loaded = await loadPluginInWorker({
    manifest,
    entryFileUrl: join(dir, 'index.js'),
    assetRootPath: dir,
    settings: {},
  })
  if (!loaded.ok) throw new Error(loaded.error ?? 'load failed')
  await runLifecycleInWorker(PLUGIN_ID, 'activate')
})

afterAll(async () => {
  await resetPluginWorker()
  hostPlugins.delete(PLUGIN_ID)
  await testDb.cleanup()
  await rm(dir, { recursive: true, force: true })
})

describe('plugin storage through a real worker', () => {
  it('lets exactly one of several concurrent route calls claim an event', async () => {
    // Eight deliveries of one webhook, in flight together on one plugin.
    const responses = await Promise.all(Array.from({ length: 8 }, () => get('/claim')))
    const claims = (await Promise.all(responses.map((res) => res.json()))) as Array<{ created: boolean; id: string }>
    expect(responses.every((res) => res.status === 200)).toBe(true)
    expect(claims.filter((claim) => claim.created)).toHaveLength(1)
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(1)

    const stored = await listPluginRecords(testDb.db, PLUGIN_ID, 'events', { filter: { eventId: 'evt_webhook' } })
    expect(stored.totalCount).toBe(1)
  }, 60_000)

  it('creates once when one handler fires createIfAbsent several times at once', async () => {
    const body = (await (await get('/burst')).json()) as { created: number; ids: string[] }
    expect(body.created).toBe(1)
    expect(new Set(body.ids).size).toBe(1)
  }, 60_000)

  it('rejects a duplicate create with the storage_duplicate prefix', async () => {
    const body = (await (await get('/duplicate')).json()) as { second: string }
    expect(body.second.startsWith('storage_duplicate:')).toBe(true)
    expect(body.second).toContain('evt_dup')
  }, 60_000)

  it('versions updates, reads by id and key, and refuses stale writes with storage_conflict', async () => {
    const body = (await (await get('/versions')).json()) as Record<string, unknown>
    expect(body).toMatchObject({
      madeVersion: 0,
      madeKey: 'evt_versions',
      firstVersion: 1,
      state: 'paid',
      sameRecord: true,
      deleted: true,
      afterDeleteIsNull: true,
      blankKeyIsNull: true,
      missingIsNull: true,
    })
    expect(String(body.stale).startsWith('storage_conflict:')).toBe(true)
    expect(String(body.staleDelete).startsWith('storage_conflict:')).toBe(true)
  }, 60_000)

  it('says what is missing when a resource has no unique field or the record no value for it', async () => {
    const body = (await (await get('/no-unique-field')).json()) as Record<string, string>
    expect(body.createIfAbsent).toContain('needs a uniqueField on the "notes" resource')
    expect(body.getByKey).toContain('needs a uniqueField on the "notes" resource')
    expect(body.missingValue).toContain('needs a value for "eventId"')
  }, 60_000)
})
