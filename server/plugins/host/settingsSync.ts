/**
 * Plugin settings synchronization — keeps the views of a plugin's settings
 * consistent on every write:
 *
 *   1. the DB rows (`installed_plugins.settings_json` + the encrypted
 *      `plugin_secrets` table) — canonical,
 *   2. the host-side runtime cache (`../settingsCache.ts`) — non-secret
 *      values merged with decrypted secrets; seeds the worker's VM mirror
 *      at load time,
 *   3. the live VM mirror (`__plugin_settings`) — read synchronously by
 *      `api.cms.settings.get(...)` inside the sandbox.
 *
 * Both write paths converge on `persistAndSyncPluginSettings`: the admin
 * settings PUT (`server/handlers/cms/plugins/settings.ts`) and the plugin's
 * own `api.cms.settings.replace(...)` (`./handlers/settings.ts`).
 */

import type { PluginSettingDefinition, PluginSettingsValues } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import type { DbClient } from '../../db/client'
import { setPluginSettings } from '../../repositories/plugins'
import { refreshPluginSettingsCache } from '../settingsCache'
import { updateSettingsInWorker } from './rpc'

/**
 * Persist a validated settings record and propagate it everywhere.
 *
 * Secret-typed fields are split into the encrypted `plugin_secrets` table
 * inside `setPluginSettings` (a `'***'` sentinel preserves the stored row,
 * a new value rotates it, an empty string clears it); a `PluginSecretError`
 * from that split propagates to the caller. The refreshed cache record —
 * non-secret values merged with the decrypted secrets — is the RUNTIME
 * view: it feeds the worker push, and nothing else. It must never be
 * serialised onto a browser-bound payload or handed to another plugin.
 *
 * `settings.changed` goes to the plugin that owns the settings and to no
 * other (`hookBus.emitTo`), and its payload names the plugin without
 * carrying a single value: the owner reads them with
 * `api.cms.settings.get(...)`.
 *
 * Ordering matters: the new record is pushed into the running VM BEFORE
 * `settings.changed` is emitted — hook listeners execute inside the worker
 * and read `api.cms.settings.get(...)` from the VM mirror, so the push has
 * to land first for a listener to observe the new values. A push failure is
 * logged rather than thrown, and the event is then NOT sent (a listener
 * would read the old values): the DB rows are already the source of truth
 * and the next worker (re)load re-seeds the mirror from them.
 *
 * Returns the runtime record — the same shape `load-plugin` seeds at worker
 * load time.
 */
export async function persistAndSyncPluginSettings(
  db: DbClient,
  pluginId: string,
  declared: ReadonlyArray<PluginSettingDefinition>,
  cleaned: PluginSettingsValues,
): Promise<PluginSettingsValues> {
  await setPluginSettings(db, pluginId, declared, cleaned)
  const runtimeSettings = (await refreshPluginSettingsCache(db, pluginId)) ?? cleaned
  try {
    await updateSettingsInWorker(pluginId, runtimeSettings)
  } catch (err) {
    // The running VM still holds the old values, so a listener told "your
    // settings changed" would read stale ones. Say nothing; the next worker
    // load seeds the mirror from the saved rows.
    console.error(`[plugin:${pluginId}] failed to push settings into worker; settings.changed not sent:`, err)
    return runtimeSettings
  }
  await hookBus.emitTo(pluginId, 'settings.changed', { pluginId })
  return runtimeSettings
}
