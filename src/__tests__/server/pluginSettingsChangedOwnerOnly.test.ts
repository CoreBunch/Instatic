/**
 * `settings.changed` reaches only the plugin whose settings changed, and
 * carries no setting values.
 *
 * Two REAL plugin workers on a real database, driven through the production
 * paths: the admin settings PUT (`handleCmsRequest`) and a plugin's own
 * `api.cms.settings.replace`. `acme.vault` owns a secret setting;
 * `acme.eavesdrop` holds only hook and route permissions and listens for
 * `settings.changed`. The bug this pins: the host used to broadcast the event,
 * with the decrypted settings in its payload, to every listening plugin.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { PluginManifest } from '@core/plugin-sdk'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import * as pluginRpc from '../../../server/plugins/host/rpc'
import { loadPluginInWorker, runLifecycleInWorker, runRouteInWorker } from '../../../server/plugins/host/rpc'
import { resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { dropCachedPluginSettings } from '../../../server/plugins/settingsCache'
import { installPlugin } from '../../../server/repositories/plugins'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const OWNER_ID = 'acme.vault'
const OTHER_ID = 'acme.eavesdrop'
const ADMIN_SECRET = 'sk_live_saved_from_the_admin_form'
const PLUGIN_SECRET = 'sk_live_saved_by_the_plugin_itself'

// Fixed 32-byte key (base64) so secret settings can be encrypted.
const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')

/** Records every `settings.changed` payload it hears and serves them back. */
const LISTENER_SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  __plugin_exports.activate = async function activate(api) {
    const heard = [];
    api.cms.hooks.on('settings.changed', function (payload) {
      heard.push({ payload: payload, apiKeyAtTheTime: api.cms.settings.get('apiKey') });
    });
    api.cms.routes.public.get('/heard', function () { return { heard: heard }; });
    api.cms.routes.public.get('/rotate', async function () {
      await api.cms.settings.replace({ apiKey: '${PLUGIN_SECRET}', mode: 'turbo' });
      return { ok: true };
    });
  };
})();
`

const PERMISSIONS = ['cms.hooks', 'cms.routes', 'cms.routes.public']

function fixtureManifest(id: string, name: string, withSettings: boolean): PluginManifest {
  return {
    ...parsePluginManifest({
      id,
      name,
      version: '1.0.0',
      apiVersion: 1,
      permissions: PERMISSIONS,
      ...(withSettings
        ? {
            settings: [
              { id: 'apiKey', type: 'password', label: 'API key', secret: true },
              { id: 'mode', type: 'text', label: 'Mode', default: 'fast' },
            ],
          }
        : {}),
    }),
    grantedPermissions: PERMISSIONS,
  }
}

let harness: CapabilityTestHarness
let cookie = ''
let dir = ''
let originalSecretKey: string | undefined

async function loadFixture(manifest: PluginManifest): Promise<void> {
  const pluginDir = join(dir, manifest.id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'index.js'), LISTENER_SOURCE)
  await installPlugin(harness.db, manifest)
  const loaded = await loadPluginInWorker({
    manifest,
    entryFileUrl: join(pluginDir, 'index.js'),
    assetRootPath: pluginDir,
    settings: {},
  })
  if (!loaded.ok) throw new Error(loaded.error ?? `load of ${manifest.id} failed`)
  await runLifecycleInWorker(manifest.id, 'activate')
}

interface Heard {
  payload: unknown
  apiKeyAtTheTime: unknown
}

async function heardBy(pluginId: string): Promise<Heard[]> {
  const res = await runRouteInWorker({
    pluginId,
    method: 'GET',
    path: '/heard',
    request: new Request(`https://site.example/_instatic/plugins/${pluginId}/heard`),
    user: null,
    member: null,
    app: null,
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { heard: Heard[] }
  return body.heard
}

beforeAll(async () => {
  originalSecretKey = process.env.INSTATIC_SECRET_KEY
  process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
  __resetMasterKeyCacheForTesting()
  dir = await mkdtemp(join(tmpdir(), 'instatic-settings-changed-'))
  harness = await createCapabilityTestHarness({ uploadsDir: dir })
  cookie = await harness.setupOwner()
  setPluginHostContext({ db: harness.db, uploadsDir: dir })
  setApiCallDispatcher(dispatchApiCall)
  await loadFixture(fixtureManifest(OWNER_ID, 'Vault', true))
  await loadFixture(fixtureManifest(OTHER_ID, 'Eavesdrop', false))
})

afterAll(async () => {
  await resetPluginWorker()
  hostPlugins.delete(OWNER_ID)
  hostPlugins.delete(OTHER_ID)
  dropCachedPluginSettings(OWNER_ID)
  dropCachedPluginSettings(OTHER_ID)
  await harness.cleanup()
  await rm(dir, { recursive: true, force: true })
  if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
  else process.env.INSTATIC_SECRET_KEY = originalSecretKey
  __resetMasterKeyCacheForTesting()
})

describe('settings.changed is for the plugin that owns the settings', () => {
  it('a save from the admin form reaches the owner only, with no values', async () => {
    const put = await harness.cms(`/admin/api/cms/plugins/${OWNER_ID}/settings`, {
      method: 'PUT',
      cookie,
      json: { settings: { apiKey: ADMIN_SECRET, mode: 'turbo' } },
    })
    expect(put.status).toBe(200)
    // The browser never gets the plaintext either.
    expect(await put.text()).not.toContain(ADMIN_SECRET)

    const other = await heardBy(OTHER_ID)
    expect(JSON.stringify(other)).not.toContain(ADMIN_SECRET)
    expect(other).toEqual([])

    const owner = await heardBy(OWNER_ID)
    expect(owner).toEqual([
      // The owner is told its settings changed and reads them itself: the VM
      // mirror already holds the new values when the listener runs.
      { payload: { pluginId: OWNER_ID }, apiKeyAtTheTime: ADMIN_SECRET },
    ])
  })

  it("a plugin's own settings.replace reaches the owner only, with no values", async () => {
    const res = await runRouteInWorker({
      pluginId: OWNER_ID,
      method: 'GET',
      path: '/rotate',
      request: new Request(`https://site.example/_instatic/plugins/${OWNER_ID}/rotate`),
      user: null,
      member: null,
      app: null,
    })
    expect(res.status).toBe(200)

    const other = await heardBy(OTHER_ID)
    expect(JSON.stringify(other)).not.toContain(PLUGIN_SECRET)
    expect(other).toEqual([])

    const owner = await heardBy(OWNER_ID)
    expect(owner.at(-1)).toEqual({ payload: { pluginId: OWNER_ID }, apiKeyAtTheTime: PLUGIN_SECRET })
    expect(JSON.stringify(owner.map((entry) => entry.payload))).not.toContain('sk_live')
  })

  it('says nothing when the new values did not reach the running plugin', async () => {
    const before = (await heardBy(OWNER_ID)).length
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const push = spyOn(pluginRpc, 'updateSettingsInWorker').mockRejectedValue(new Error('worker refused'))
    try {
      const put = await harness.cms(`/admin/api/cms/plugins/${OWNER_ID}/settings`, {
        method: 'PUT',
        cookie,
        json: { settings: { apiKey: 'sk_live_never_pushed', mode: 'turbo' } },
      })
      // The save itself stands: the rows are the source of truth.
      expect(put.status).toBe(200)
      expect(push).toHaveBeenCalledTimes(1)
      expect(errorLog).toHaveBeenCalledWith(
        `[plugin:${OWNER_ID}] failed to push settings into worker; settings.changed not sent:`,
        expect.any(Error),
      )
    } finally {
      push.mockRestore()
      errorLog.mockRestore()
    }
    // A listener would have read the old key, so the owner was not told.
    expect((await heardBy(OWNER_ID)).length).toBe(before)
  })
})
