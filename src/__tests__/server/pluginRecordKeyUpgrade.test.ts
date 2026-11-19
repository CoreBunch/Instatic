/**
 * A plugin upgrade that adds, changes or removes a resource's `uniqueField`.
 *
 * Stored record keys have to follow the declaration: an upgrade whose new
 * unique field collides among existing records is refused before anything is
 * touched, one that fits rebuilds the keys, and dropping the field clears
 * them. Real handlers, real SQLite, through the upload endpoint an admin uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { setPluginHostContext } from '../../../server/plugins/host/registry'
import { getPluginRecordByKey, listPluginRecords } from '../../../server/repositories/pluginRecords'
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
