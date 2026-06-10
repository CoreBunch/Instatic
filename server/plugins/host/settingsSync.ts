/**
 * Plugin settings synchronization — keeps the three views of a plugin's
 * settings consistent on every write:
 *
 *   1. the DB row (`installed_plugins.settings_json`) — canonical,
 *   2. the host-side `pluginSettingsCache` below — seeds the worker's VM
 *      mirror at load time,
 *   3. the live VM mirror (`__plugin_settings`) — read synchronously by
 *      `api.cms.settings.get(...)` inside the sandbox.
 *
 * Both write paths converge on `persistAndSyncPluginSettings`: the admin
 * settings PUT (`server/handlers/cms/plugins/settings.ts`) and the plugin's
 * own `api.cms.settings.replace(...)` (`./handlers/settings.ts`).
 */

import type { PluginSettingsValues } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import type { DbClient } from '../../db/client'
import { setPluginSettings } from '../../repositories/plugins'
import { updateSettingsInWorker } from './rpc'

/**
 * Host-side settings cache — the merged-with-defaults record per plugin id.
 * `loadPluginServerEntrypoint` reads it to seed the VM's `__plugin_settings`
 * mirror at load time; every settings write refreshes it via
 * `persistAndSyncPluginSettings` (or directly around install / upgrade /
 * lifecycle flows that already hold the canonical row).
 */
export const pluginSettingsCache = new Map<string, PluginSettingsValues>()

/**
 * Persist a validated settings record and propagate it everywhere.
 *
 * Ordering matters: the new record is pushed into the running VM BEFORE
 * `settings.changed` is emitted — hook listeners execute inside the worker
 * and read `api.cms.settings.get(...)` from the VM mirror, so the push has
 * to land first for a listener to observe the new values. A push failure is
 * logged rather than thrown: the DB row is already the source of truth and
 * the next worker (re)load re-seeds the mirror from it.
 *
 * Returns the merged-with-defaults record the repository produced — the
 * same shape `load-plugin` seeds at worker load time.
 */
export async function persistAndSyncPluginSettings(
  db: DbClient,
  pluginId: string,
  cleaned: PluginSettingsValues,
): Promise<PluginSettingsValues> {
  const persisted = await setPluginSettings(db, pluginId, cleaned)
  const merged = persisted?.kind === 'ok' ? persisted.plugin.settings : cleaned
  pluginSettingsCache.set(pluginId, merged)
  try {
    await updateSettingsInWorker(pluginId, merged)
  } catch (err) {
    console.error(`[plugin:${pluginId}] failed to push settings into worker:`, err)
  }
  await hookBus.emit('settings.changed', { pluginId, settings: merged })
  return merged
}
