/**
 * Plugin settings cache — the host-side record that seeds each loaded
 * plugin's in-worker `api.cms.settings.get` mirror.
 *
 * The cached record is the RUNTIME view: `plugin.settings` (defaults +
 * non-secret stored values) merged with the decrypted secret settings from
 * `plugin_secrets`. It exists only inside the server process and must never
 * be serialised onto a browser-bound payload — handlers project secrets
 * through `listPluginSecretStates` instead.
 *
 * Lives in its own module (not runtime.ts) so both the admin settings route
 * and the worker host's `cms.settings.replace` handler can refresh it
 * without importing the runtime orchestrator (which imports the api-call
 * dispatcher, which imports the settings handler — a cycle otherwise).
 */

import type { DbClient } from '../db/client'
import type { InstalledPlugin, PluginSettingsValues } from '@core/plugin-sdk'
import { getInstalledPlugin } from '../repositories/plugins'
import { resolvePluginSecretsForRuntime } from '../repositories/pluginSecrets'

const pluginSettingsCache = new Map<string, PluginSettingsValues>()

/** Read the cached runtime settings record. Empty when not yet primed. */
export function getCachedPluginSettings(pluginId: string): PluginSettingsValues {
  return pluginSettingsCache.get(pluginId) ?? {}
}

/** Forget a plugin's cached settings — called when the plugin unloads. */
export function dropCachedPluginSettings(pluginId: string): void {
  pluginSettingsCache.delete(pluginId)
}

/**
 * Prime the cache from an already-loaded plugin row: merge the decrypted
 * secret settings over `plugin.settings` (where secret fields are always
 * `''`). A secret that can't be decrypted (master key rotated) stays `''` —
 * plugin load proceeds, the worker just sees the field empty.
 */
export async function primePluginSettingsCache(
  db: DbClient,
  plugin: InstalledPlugin,
): Promise<PluginSettingsValues> {
  const secrets = await resolvePluginSecretsForRuntime(
    db,
    plugin.id,
    plugin.manifest.settings ?? [],
  )
  const merged: PluginSettingsValues = { ...plugin.settings, ...secrets }
  pluginSettingsCache.set(plugin.id, merged)
  return merged
}

/**
 * Re-read a plugin's settings from the canonical rows and prime the cache.
 * Returns the merged runtime record, or null when the plugin row is missing
 * or its manifest is broken.
 */
export async function refreshPluginSettingsCache(
  db: DbClient,
  pluginId: string,
): Promise<PluginSettingsValues | null> {
  const result = await getInstalledPlugin(db, pluginId)
  if (!result || result.kind !== 'ok') return null
  return primePluginSettingsCache(db, result.plugin)
}
