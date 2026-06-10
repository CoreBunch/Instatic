/**
 * Plugin secret settings — repository-level tests against a real SQLite DB
 * (migrations applied), covering the encrypt-at-rest split:
 *
 *   - secret values land encrypted in `plugin_secrets`, never `settings_json`
 *   - the runtime resolution returns decrypted plaintext
 *   - the `'***'` sentinel preserves, a new value rotates, `''` clears
 *   - a master-key fingerprint mismatch degrades to "needs re-entry"
 *     without crashing the runtime read
 *   - uninstall cascades the rows (FK `on delete cascade`)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PluginManifest, PluginSettingDefinition } from '@core/plugin-sdk'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  deletePlugin,
  getInstalledPlugin,
  installPlugin,
  setPluginSettings,
} from '../../../server/repositories/plugins'
import {
  listPluginSecretStates,
  resolvePluginSecretsForRuntime,
} from '../../../server/repositories/pluginSecrets'
import { primePluginSettingsCache } from '../../../server/plugins/settingsCache'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

// Fixed 32-byte key (base64) so fingerprints are deterministic per test run.
const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')

const declaredSettings: PluginSettingDefinition[] = [
  { id: 'apiKey', type: 'password', label: 'API key', secret: true },
  { id: 'mode', type: 'text', label: 'Mode', default: 'fast' },
]

const manifest: PluginManifest = {
  id: 'local.vault',
  name: 'Vault',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [],
  resources: [],
  adminPages: [],
  settings: declaredSettings,
}

describe('plugin secret settings repository', () => {
  let testDb: TestDb
  let originalSecretKey: string | undefined

  beforeEach(async () => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
    testDb = await createTestDb()
  })

  afterEach(async () => {
    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
    __resetMasterKeyCacheForTesting()
    await testDb.cleanup()
  })

  async function secretRows() {
    const { rows } = await testDb.db<{
      setting_id: string
      ciphertext: Uint8Array
      iv: Uint8Array
      key_fingerprint: string
    }>`
      select setting_id, ciphertext, iv, key_fingerprint
      from plugin_secrets
      where plugin_id = ${manifest.id}
      order by setting_id
    `
    return rows
  }

  async function storedSettingsJson(): Promise<Record<string, unknown>> {
    const { rows } = await testDb.db<{ settings_json: unknown }>`
      select settings_json from installed_plugins where id = ${manifest.id}
    `
    const raw = rows[0]?.settings_json
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
  }

  it('stores secrets encrypted, outside settings_json, and decrypts them for the runtime', async () => {
    const plugin = await installPlugin(testDb.db, manifest)
    // plugin.settings never carries the secret — always '' on read.
    expect(plugin.settings).toEqual({ apiKey: '', mode: 'fast' })

    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: 'real-secret',
      mode: 'turbo',
    })

    // settings_json no longer contains the secret field at all.
    expect(await storedSettingsJson()).toEqual({ mode: 'turbo' })

    // The row stores ciphertext + IV, and no plaintext appears anywhere in it.
    const rows = await secretRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].setting_id).toBe('apiKey')
    expect(rows[0].ciphertext.length).toBeGreaterThan(0)
    expect(rows[0].iv.length).toBe(12)
    expect(rows[0].key_fingerprint).toMatch(/^[0-9a-f]{16}$/)
    const rowText = Buffer.concat([
      Buffer.from(rows[0].ciphertext),
      Buffer.from(rows[0].iv),
    ]).toString('latin1')
    expect(rowText).not.toContain('real-secret')

    // Reading the plugin row back still yields '' for the secret field.
    const reread = await getInstalledPlugin(testDb.db, manifest.id)
    expect(reread?.kind).toBe('ok')
    if (reread?.kind !== 'ok') throw new Error('unreachable')
    expect(reread.plugin.settings).toEqual({ apiKey: '', mode: 'turbo' })

    // The runtime projection — and only it — returns the plaintext.
    const secrets = await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declaredSettings)
    expect(secrets).toEqual({ apiKey: 'real-secret' })

    // The worker settings cache merges the decrypted value over the row.
    const runtime = await primePluginSettingsCache(testDb.db, reread.plugin)
    expect(runtime).toEqual({ apiKey: 'real-secret', mode: 'turbo' })
  })

  it("preserves on the '***' sentinel, rotates on a new value, clears on ''", async () => {
    await installPlugin(testDb.db, manifest)
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: 'first-secret',
      mode: 'fast',
    })
    const [initial] = await secretRows()

    // Sentinel round-trip: row untouched (same ciphertext bytes).
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: '***',
      mode: 'slow',
    })
    const [afterSentinel] = await secretRows()
    expect(Buffer.from(afterSentinel.ciphertext).equals(Buffer.from(initial.ciphertext))).toBe(true)
    expect(await storedSettingsJson()).toEqual({ mode: 'slow' })
    expect(await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declaredSettings))
      .toEqual({ apiKey: 'first-secret' })

    // Rotation: new ciphertext, new plaintext.
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: 'second-secret',
      mode: 'slow',
    })
    const [afterRotate] = await secretRows()
    expect(Buffer.from(afterRotate.ciphertext).equals(Buffer.from(initial.ciphertext))).toBe(false)
    expect(await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declaredSettings))
      .toEqual({ apiKey: 'second-secret' })

    // Clear: the row is deleted.
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: '',
      mode: 'slow',
    })
    expect(await secretRows()).toHaveLength(0)
    expect(await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declaredSettings)).toEqual({})
    expect(await listPluginSecretStates(testDb.db, manifest.id)).toEqual([])
  })

  it('seeds an encrypted row for a secret manifest default and preserves it across the upgrade upsert', async () => {
    const withDefault: PluginManifest = {
      ...manifest,
      settings: [
        { id: 'apiKey', type: 'password', label: 'API key', secret: true, default: 'seed-secret' },
        { id: 'mode', type: 'text', label: 'Mode', default: 'fast' },
      ],
    }
    const declared = withDefault.settings!

    await installPlugin(testDb.db, withDefault)
    expect(await storedSettingsJson()).toEqual({ mode: 'fast' })
    expect(await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declared))
      .toEqual({ apiKey: 'seed-secret' })

    // Owner rotates, then an upgrade re-runs the install upsert — the rotated
    // value must survive (seed is insert-if-absent).
    await setPluginSettings(testDb.db, manifest.id, declared, { apiKey: 'rotated', mode: 'fast' })
    await installPlugin(testDb.db, { ...withDefault, version: '1.1.0' })
    expect(await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declared))
      .toEqual({ apiKey: 'rotated' })
  })

  it('degrades a master-key fingerprint mismatch to needs-re-entry without crashing', async () => {
    await installPlugin(testDb.db, manifest)
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: 'real-secret',
      mode: 'fast',
    })

    // Simulate a master-key rotation: the stored fingerprint no longer
    // matches the live key.
    await testDb.db`
      update plugin_secrets set key_fingerprint = ${'deadbeefdeadbeef'}
      where plugin_id = ${manifest.id} and setting_id = ${'apiKey'}
    `

    const originalError = console.error
    const logged: string[] = []
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    try {
      // Runtime read: field absent, no throw.
      const secrets = await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declaredSettings)
      expect(secrets).toEqual({})
    } finally {
      console.error = originalError
    }
    expect(logged.join('\n')).toContain(`[plugin:${manifest.id}]`)
    expect(logged.join('\n')).not.toContain('real-secret')

    // State projection: the field reports a stale fingerprint so the admin
    // settings UI can prompt for re-entry.
    const states = await listPluginSecretStates(testDb.db, manifest.id)
    expect(states).toEqual([{ settingId: 'apiKey', keyFingerprintCurrent: false }])

    // Re-entering the secret heals the row.
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: 're-entered',
      mode: 'fast',
    })
    expect(await resolvePluginSecretsForRuntime(testDb.db, manifest.id, declaredSettings))
      .toEqual({ apiKey: 're-entered' })
    expect(await listPluginSecretStates(testDb.db, manifest.id))
      .toEqual([{ settingId: 'apiKey', keyFingerprintCurrent: true }])
  })

  it('cascades plugin_secrets rows on uninstall', async () => {
    await installPlugin(testDb.db, manifest)
    await setPluginSettings(testDb.db, manifest.id, declaredSettings, {
      apiKey: 'real-secret',
      mode: 'fast',
    })
    expect(await secretRows()).toHaveLength(1)

    expect(await deletePlugin(testDb.db, manifest.id)).toBe(true)
    expect(await secretRows()).toHaveLength(0)
  })
})
