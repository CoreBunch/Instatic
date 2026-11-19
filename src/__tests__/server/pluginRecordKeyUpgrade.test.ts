/**
 * A plugin upgrade that adds, changes or removes a resource's `uniqueField`.
 *
 * Stored record keys have to follow the declaration: an upgrade whose new
 * unique field collides among existing records is refused before anything is
 * touched, one that fits rebuilds the keys, and dropping the field clears
 * them. The same holds for a JSON install, for a resource declared for the
 * first time over records that already exist, and for the rollback of a
 * failed upgrade. Real handlers, real SQLite, through the admin endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import { resetPluginWorker } from '../../../server/plugins/host/workerPool'
import {
  createPluginRecord,
  getPluginRecordByKey,
  listPluginRecords,
} from '../../../server/repositories/pluginRecords'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const PLUGIN = 'acme.keys'
const scope = { pluginId: PLUGIN, resourceId: 'events' }

function packageFor(version: string, uniqueField?: string): FormData {
  const manifest = {
    id: PLUGIN,
    name: 'Keys',
    version,
    apiVersion: 1,
    permissions: ['cms.storage'],
    resources: [
      {
        id: 'events',
        title: 'Events',
        ...(uniqueField ? { uniqueField } : {}),
        fields: [
          { id: 'eventId', label: 'Event id', type: 'text' },
          { id: 'state', label: 'State', type: 'text' },
        ],
      },
    ],
    adminPages: [],
  }
  const zipped = zipSync({ 'plugin.json': strToU8(JSON.stringify(manifest)) })
  const form = new FormData()
  form.set('file', new File([zipped], 'keys.zip', { type: 'application/zip' }))
  form.set('grantedPermissions', JSON.stringify(['cms.storage']))
  return form
}

let harness: CapabilityTestHarness
let cookie = ''
let uploadsDir = ''

function upload(version: string, uniqueField?: string): Promise<Response> {
  return harness.cms('/admin/api/cms/plugins/package', {
    method: 'POST',
    cookie,
    body: packageFor(version, uniqueField),
  })
}

function createRecord(data: Record<string, string>): Promise<Response> {
  return harness.cms(`/admin/api/cms/plugins/${PLUGIN}/resources/events/records`, {
    method: 'POST',
    cookie,
    json: { data },
  })
}

async function installedVersion(): Promise<string | undefined> {
  const { rows } = await harness.db<{ version: string }>`select version from installed_plugins where id = ${PLUGIN}`
  return rows[0]?.version
}

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-keys-'))
  harness = await createCapabilityTestHarness({ uploadsDir })
  cookie = await harness.setupOwner()
  setPluginHostContext({ db: harness.db, uploadsDir })

  expect((await upload('1.0.0')).status).toBe(201)
  expect((await createRecord({ eventId: 'evt_1', state: 'paid' })).status).toBe(201)
  expect((await createRecord({ eventId: 'evt_2', state: 'paid' })).status).toBe(201)
})

afterAll(async () => {
  await resetPluginWorker()
  await harness.cleanup()
  await rm(uploadsDir, { recursive: true, force: true })
})

describe('upgrading a plugin whose resource changes its uniqueField', () => {
  it('refuses a unique field that existing records share, leaving the old version installed', async () => {
    const res = await upload('1.1.0', 'state')
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('This version cannot be installed')
    expect(body.error).toContain('share the "state" value "paid"')
    expect(await installedVersion()).toBe('1.0.0')
    expect((await listPluginRecords(harness.db, PLUGIN, 'events')).totalCount).toBe(2)
  })

  it('rebuilds the keys when the new unique field fits, then enforces it', async () => {
    const res = await upload('1.1.0', 'eventId')
    expect(res.status).toBe(200)
    expect(await installedVersion()).toBe('1.1.0')
    expect((await getPluginRecordByKey(harness.db, scope, 'evt_1'))?.data).toMatchObject({ state: 'paid' })
    expect(await getPluginRecordByKey(harness.db, scope, 'evt_2')).not.toBeNull()

    // The admin resource page now gets a clear refusal for a duplicate.
    const duplicate = await createRecord({ eventId: 'evt_1', state: 'again' })
    expect(duplicate.status).toBe(409)
    expect((await readJson<{ error: string }>(duplicate)).error).toContain('"evt_1" already exists')
    expect((await createRecord({ eventId: 'evt_3', state: 'new' })).status).toBe(201)
  })

  it('clears the keys when the unique field goes away', async () => {
    const res = await upload('1.2.0')
    expect(res.status).toBe(200)
    expect(await getPluginRecordByKey(harness.db, scope, 'evt_1')).toBeNull()
    // Nothing is unique any more, so the duplicate is accepted.
    expect((await createRecord({ eventId: 'evt_1', state: 'again' })).status).toBe(201)
  })
})

describe('a JSON install that changes what a resource declares', () => {
  const JSON_PLUGIN = 'acme.jsonkeys'
  const late = { pluginId: JSON_PLUGIN, resourceId: 'late' }

  function install(version: string, resources: unknown[]): Promise<Response> {
    return harness.cms('/admin/api/cms/plugins', {
      method: 'POST',
      cookie,
      json: {
        manifest: { id: JSON_PLUGIN, name: 'JSON keys', version, apiVersion: 1, permissions: ['cms.storage'], resources },
        grantedPermissions: ['cms.storage'],
      },
    })
  }
  const lateResource = (uniqueField?: string) => ({
    id: 'late',
    title: 'Late',
    ...(uniqueField ? { uniqueField } : {}),
    fields: [
      { id: 'code', label: 'Code', type: 'text' },
      { id: 'kind', label: 'Kind', type: 'text' },
    ],
  })

  it('keys records that were stored before the resource was declared', async () => {
    expect((await install('1.0.0', [])).status).toBe(201)
    // Written while "late" was not in the manifest: no keys.
    await createPluginRecord(harness.db, { ...late, id: 'late_a', data: { code: ' a ', kind: 'x' }, uniqueKey: null })
    await createPluginRecord(harness.db, { ...late, id: 'late_b', data: { code: 'b', kind: 'x' }, uniqueKey: null })

    expect((await install('1.1.0', [lateResource('code')])).status).toBe(201)
    // Trimmed like a write, so a later createIfAbsent / getByKey finds them.
    expect((await getPluginRecordByKey(harness.db, late, 'a'))?.id).toBe('late_a')
    expect((await getPluginRecordByKey(harness.db, late, 'b'))?.id).toBe('late_b')
  })

  it('refuses a manifest whose unique field existing records share, changing nothing', async () => {
    const res = await install('1.2.0', [lateResource('kind')])
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toContain('share the "kind" value "x"')
    const { rows } = await harness.db<{ version: string }>`select version from installed_plugins where id = ${JSON_PLUGIN}`
    expect(rows[0]?.version).toBe('1.1.0')
    // Keys are still the ones version 1.1.0 declared.
    expect((await getPluginRecordByKey(harness.db, late, 'a'))?.id).toBe('late_a')
  })
})

describe('rolling back a failed upgrade', () => {
  const ROLLBACK_PLUGIN = 'acme.keysback'
  const events = { pluginId: ROLLBACK_PLUGIN, resourceId: 'events' }

  function packageWith(version: string, uniqueField: string, activate: string): FormData {
    const manifest = {
      id: ROLLBACK_PLUGIN,
      name: 'Keys rollback',
      version,
      apiVersion: 1,
      permissions: ['cms.storage', 'cms.routes'],
      entrypoints: { server: 'server/index.js' },
      resources: [
        {
          id: 'events',
          title: 'Events',
          uniqueField,
          fields: [
            { id: 'eventId', label: 'Event id', type: 'text' },
            { id: 'state', label: 'State', type: 'text' },
          ],
        },
      ],
      adminPages: [],
    }
    const zipped = zipSync({
      'plugin.json': strToU8(JSON.stringify(manifest)),
      'server/index.js': strToU8(activate),
    })
    const form = new FormData()
    form.set('file', new File([zipped], 'keysback.zip', { type: 'application/zip' }))
    form.set('grantedPermissions', JSON.stringify(['cms.storage', 'cms.routes']))
    return form
  }
  const uploadPackage = (form: FormData) =>
    harness.cms('/admin/api/cms/plugins/package', { method: 'POST', cookie, body: form })

  it('puts the stored keys back to what the restored version declares', async () => {
    expect((await uploadPackage(packageWith('1.0.0', 'eventId', 'export function activate() {}'))).status).toBe(201)
    await createPluginRecord(harness.db, { ...events, id: 'back_1', data: { eventId: 'evt_1', state: 's1' }, uniqueKey: 'evt_1' })
    await createPluginRecord(harness.db, { ...events, id: 'back_2', data: { eventId: 'evt_2', state: 's2' }, uniqueKey: 'evt_2' })

    // 1.1.0 keys by "state" (which fits), then fails to activate.
    const res = await uploadPackage(
      packageWith('1.1.0', 'state', `export function activate() { throw new Error('v2 will not start') }`),
    )
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toContain('Rolled back to version 1.0.0')

    const { rows } = await harness.db<{ version: string }>`select version from installed_plugins where id = ${ROLLBACK_PLUGIN}`
    expect(rows[0]?.version).toBe('1.0.0')
    // Keyed by eventId again, not by state.
    expect((await getPluginRecordByKey(harness.db, events, 'evt_1'))?.id).toBe('back_1')
    expect((await getPluginRecordByKey(harness.db, events, 'evt_2'))?.id).toBe('back_2')
    expect(await getPluginRecordByKey(harness.db, events, 's1')).toBeNull()
  }, 60_000)

  it('leaves the plugin unloaded in error when the previous keys can no longer be restored', async () => {
    const STUCK_PLUGIN = 'acme.keysstuck'
    const stuck = { pluginId: STUCK_PLUGIN, resourceId: 'events' }
    const packageFor = (version: string, uniqueField: string, activate: string): FormData => {
      const manifest = {
        id: STUCK_PLUGIN,
        name: 'Keys stuck',
        version,
        apiVersion: 1,
        permissions: ['cms.storage', 'cms.routes'],
        entrypoints: { server: 'server/index.js' },
        resources: [
          {
            id: 'events',
            title: 'Events',
            uniqueField,
            fields: [
              { id: 'eventId', label: 'Event id', type: 'text' },
              { id: 'state', label: 'State', type: 'text' },
            ],
          },
        ],
        adminPages: [],
      }
      const zipped = zipSync({
        'plugin.json': strToU8(JSON.stringify(manifest)),
        'server/index.js': strToU8(activate),
      })
      const form = new FormData()
      form.set('file', new File([zipped], 'keysstuck.zip', { type: 'application/zip' }))
      form.set('grantedPermissions', JSON.stringify(['cms.storage', 'cms.routes']))
      return form
    }

    expect((await uploadPackage(packageFor('1.0.0', 'eventId', 'export function activate() {}'))).status).toBe(201)
    await createPluginRecord(harness.db, { ...stuck, id: 'stuck_1', data: { eventId: 'evt_1', state: 's1' }, uniqueKey: 'evt_1' })

    // 1.1.0 keys by "state". Before failing, it stores a second record with
    // the SAME eventId (allowed now), so 1.0.0's keys cannot come back.
    const res = await uploadPackage(
      packageFor(
        '1.1.0',
        'state',
        `export async function activate(api) {
           await api.cms.storage.collection('events').create({ eventId: 'evt_1', state: 's2' })
           throw new Error('v2 will not start')
         }`,
      ),
    )
    expect(res.status).toBe(400)

    const { rows } = await harness.db<{ version: string; lifecycle_status: string; last_error: string | null }>`
      select version, lifecycle_status, last_error from installed_plugins where id = ${STUCK_PLUGIN}
    `
    // Not restored, and it says so: never reported as running.
    expect(rows[0]?.lifecycle_status).toBe('error')
    expect(rows[0]?.last_error).toContain('version 1.0.0 could not be restored')
    expect(rows[0]?.last_error).toContain('share the "eventId" value "evt_1"')
    // The manifest and the keys are those of the last transaction that
    // succeeded (1.1.0, keyed by state): consistent with each other.
    expect(rows[0]?.version).toBe('1.1.0')
    expect((await getPluginRecordByKey(harness.db, stuck, 's1'))?.id).toBe('stuck_1')
    expect(await getPluginRecordByKey(harness.db, stuck, 'evt_1')).toBeNull()
    expect(hostPlugins.has(STUCK_PLUGIN)).toBe(false)
  }, 60_000)
})
