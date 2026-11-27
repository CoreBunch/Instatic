/**
 * An id in a plugin's namespace belongs to that plugin, also when plugin ids
 * nest: with `acme.vault` and `acme.vault.x` loaded, `acme.vault.x.<name>`
 * starts with both ids and is the second plugin's.
 *
 * Two REAL plugin workers. `acme.vault.x` registers a loop source and a media
 * storage adapter; `acme.vault` then tries to register the same ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopSourceRegistry } from '@core/loops/registry'
import { parsePluginManifest } from '@core/plugins/manifest'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { isInPluginNamespace, mayReplaceRegistration, owningPluginId } from '@core/plugins/namespaceOwnership'
import type { PluginManifest } from '@core/plugin-sdk'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { hostPlugins, setPluginHostContext } from '../../../server/plugins/host/registry'
import {
  loadPluginInWorker,
  runLifecycleInWorker,
  runRouteInWorker,
  unloadPluginInWorker,
} from '../../../server/plugins/host/rpc'
import { resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { installPlugin, listInstalledPluginIds } from '../../../server/repositories/plugins'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const INNER = 'acme.vault.x'
const OUTER = 'acme.vault'
const SOURCE_ID = 'acme.vault.x.offers'
const ADAPTER_ID = 'acme.vault.x.files'

/** Registers both ids, answering as itself, and reports what was refused. */
const SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  __plugin_exports.activate = async function activate(api) {
    const refused = {};
    const me = api.plugin.id;
    try {
      await api.cms.loops.registerSource({
        id: '${SOURCE_ID}', label: 'Offers', filterSchema: {}, orderByOptions: [],
        fields: [{ id: 'label', label: 'Label' }], preview: function () { return []; },
        fetch: function () { return { items: [{ id: '1', label: 'served by ' + me }], totalItems: 1 }; },
      });
    } catch (e) { refused.source = e.message; }
    try {
      await api.cms.media.registerStorageAdapter({
        id: '${ADAPTER_ID}', label: 'Files', roles: ['original'], servingMode: 'public-url',
        beginWrite: function () { return {}; }, finalizeWrite: function () { return {}; },
        abortWrite: function () {}, delete: function () {},
        getReadUrl: function () { return 'https://files.example/x'; },
        verify: function () { return { ok: false, reason: 'answered by ' + me }; },
      });
    } catch (e) { refused.adapter = e.message; }
    api.cms.routes.public.get('/refused', function () { return refused; });
    api.cms.routes.public.get('/emit', async function () {
      try { return { name: await api.cms.hooks.emit('plugin.${INNER}.paid', {}) }; }
      catch (e) { return { refused: e.message }; }
    });
  };
})();
`

const PERMISSIONS = ['cms.routes', 'cms.routes.public', 'cms.hooks', 'loops.register', 'media.storage.adapter']

let testDb: CapabilityTestHarness
let owner = ''
let dir = ''

function manifestFor(id: string): PluginManifest {
  return {
    ...parsePluginManifest({ id, name: id, version: '1.0.0', apiVersion: 1, permissions: PERMISSIONS }),
    grantedPermissions: PERMISSIONS,
  } as PluginManifest
}

async function load(id: string): Promise<void> {
  const manifest = manifestFor(id)
  const pluginDir = join(dir, id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'index.js'), SOURCE)
  const loaded = await loadPluginInWorker({
    manifest,
    entryFileUrl: join(pluginDir, 'index.js'),
    assetRootPath: pluginDir,
    settings: {},
  })
  if (!loaded.ok) throw new Error(loaded.error ?? `load of ${id} failed`)
  await runLifecycleInWorker(id, 'activate')
}

async function ask(pluginId: string, path: string): Promise<Record<string, string>> {
  const res = await runRouteInWorker({
    pluginId,
    method: 'GET',
    path,
    request: new Request(`https://site.example/_instatic/plugins/${pluginId}${path}`),
    user: null,
    member: null,
    app: null,
  })
  return (await res.json()) as Record<string, string>
}

function refusedFor(pluginId: string): Promise<Record<string, string>> {
  return ask(pluginId, '/refused')
}

async function whoServesTheSource(): Promise<unknown> {
  const source = loopSourceRegistry.getOrThrow(SOURCE_ID)
  const result = await source.fetch({ filters: {}, limit: 10, offset: 0 } as never)
  return result.items[0]?.label
}

async function whoAnswersTheAdapter(): Promise<string | undefined> {
  const adapter = mediaStorageRegistry.resolveForRead(ADAPTER_ID)
  const verdict = await adapter!.verify()
  return verdict.ok ? undefined : verdict.reason
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'instatic-namespace-'))
  testDb = await createCapabilityTestHarness({ uploadsDir: dir })
  owner = await testDb.setupOwner()
  setPluginHostContext({ db: testDb.db, uploadsDir: dir })
  mediaStorageRegistry.configureLocalDisk({ uploadsDir: dir })
  setApiCallDispatcher(dispatchApiCall)
})

afterAll(async () => {
  await resetPluginWorker()
  for (const id of [INNER, OUTER]) hostPlugins.delete(id)
  loopSourceRegistry.unregister(SOURCE_ID)
  mediaStorageRegistry.unregisterPlugin(INNER)
  mediaStorageRegistry.unregisterPlugin(OUTER)
  await testDb.cleanup()
  await rm(dir, { recursive: true, force: true })
})

describe('ownership of namespaced ids', () => {
  it('names the longest plugin id as the owner', () => {
    expect(isInPluginNamespace('acme.vault.offers', 'acme.vault')).toBe(true)
    expect(isInPluginNamespace('acme.vaults.offers', 'acme.vault')).toBe(false)
    expect(isInPluginNamespace('acme.vault.', 'acme.vault')).toBe(false)
    expect(owningPluginId(SOURCE_ID, [OUTER, INNER])).toBe(INNER)
    expect(owningPluginId('acme.vault.offers', [OUTER, INNER])).toBe(OUTER)
    expect(owningPluginId('other.offers', [OUTER, INNER])).toBeNull()
    expect(mayReplaceRegistration(SOURCE_ID, INNER, OUTER)).toBe(true)
    expect(mayReplaceRegistration(SOURCE_ID, OUTER, INNER)).toBe(false)
    expect(mayReplaceRegistration(SOURCE_ID, INNER, INNER)).toBe(true)
  })

  it('a plugin cannot take over an id inside a nested plugin\'s namespace', async () => {
    await load(INNER)
    await load(OUTER)

    const refused = await refusedFor(OUTER)
    expect(refused.source).toContain(`belongs to plugin "${INNER}"`)
    expect(refused.adapter).toContain(`belongs to plugin "${INNER}"`)
    expect(await refusedFor(INNER)).toEqual({})
    expect(await whoServesTheSource()).toBe(`served by ${INNER}`)
    expect(await whoAnswersTheAdapter()).toBe(`answered by ${INNER}`)

    // An event name inside the inner plugin's namespace is the inner plugin's to emit.
    expect((await ask(OUTER, '/emit')).refused).toContain(`belongs to plugin "${INNER}"`)
    expect(await ask(INNER, '/emit')).toEqual({ name: `plugin.${INNER}.paid` })

    // Unloading the outer plugin leaves the inner plugin's registrations alone.
    await unloadPluginInWorker(OUTER)
    expect(loopSourceRegistry.has(SOURCE_ID)).toBe(true)
    expect(await whoAnswersTheAdapter()).toBe(`answered by ${INNER}`)
  })

  it('the rightful owner takes its id back from a plugin that registered it first', async () => {
    await unloadPluginInWorker(INNER)
    await load(OUTER)
    // Alone, the outer plugin's prefix is the only one that fits.
    expect(await whoServesTheSource()).toBe(`served by ${OUTER}`)

    await load(INNER)
    expect(await refusedFor(INNER)).toEqual({})
    expect(await whoServesTheSource()).toBe(`served by ${INNER}`)
    expect(await whoAnswersTheAdapter()).toBe(`answered by ${INNER}`)
    // And it stays with the owner when the other plugin goes away.
    await unloadPluginInWorker(OUTER)
    expect(await whoServesTheSource()).toBe(`served by ${INNER}`)
    expect(await whoAnswersTheAdapter()).toBe(`answered by ${INNER}`)
  })

  it('an installed plugin keeps its namespace while it is not loaded', async () => {
    await unloadPluginInWorker(INNER)
    await installPlugin(testDb.db, manifestFor(INNER))
    await load(OUTER)
    const refused = await refusedFor(OUTER)
    expect(refused.source).toContain(`belongs to plugin "${INNER}"`)
    expect(refused.adapter).toContain(`belongs to plugin "${INNER}"`)
    expect((await ask(OUTER, '/emit')).refused).toContain(`belongs to plugin "${INNER}"`)
    expect(loopSourceRegistry.has(SOURCE_ID)).toBe(false)
  })

  it('a plugin whose id nests with an installed one cannot be installed', async () => {
    const install = (id: string) =>
      testDb.cms('/admin/api/cms/plugins', {
        method: 'POST',
        cookie: owner,
        json: { manifest: { id, name: id, version: '1.0.0', apiVersion: 1, permissions: [] }, grantedPermissions: [] },
      })
    // `acme.vault.x` is installed (above). Its prefix and anything under it are refused.
    for (const id of [OUTER, 'acme.vault.x.y']) {
      const res = await install(id)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain(`cannot be installed next to "${INNER}"`)
    }
    // A sibling is not nested, and neither is a look-alike without the dot.
    expect((await install('acme.vaults')).status).toBe(201)
    expect((await install('acme.other')).status).toBe(201)
    // Re-installing the plugin that is already there is still allowed.
    expect((await install(INNER)).status).toBe(201)
  })

  it('two installs of a nested pair at the same moment do not both go through', async () => {
    const install = (id: string) =>
      testDb.cms('/admin/api/cms/plugins', {
        method: 'POST',
        cookie: owner,
        json: { manifest: { id, name: id, version: '1.0.0', apiVersion: 1, permissions: [] }, grantedPermissions: [] },
      })
    for (let round = 0; round < 5; round++) {
      const base = `race${round}.base`
      const statuses = (await Promise.all([install(base), install(`${base}.child`)])).map((res) => res.status)
      expect(statuses.sort()).toEqual([201, 400])
      const installed = await listInstalledPluginIds(testDb.db)
      expect(installed.filter((id) => id.startsWith(`race${round}.`))).toHaveLength(1)
    }
  })
})
