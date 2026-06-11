/**
 * One helper: `runPluginLifecycleHook`. Wraps the load-into-worker,
 * run-hook, on-error rollback sequence for `install` / `activate` /
 * `deactivate` / `uninstall`, and keeps the lifecycle status column in
 * sync with the outcome.
 *
 * `migrate` is deliberately excluded — its signature differs (takes a
 * context object) and the upgrade flow drives it directly through
 * `runPluginMigrate` so it can sequence migrate between deactivate and
 * activate atomically.
 */
import type { DbClient } from '../../../db/client'
import { setPluginLifecycleStatus } from '../../../repositories/plugins'
import type {
  InstalledPlugin,
  PluginLifecycleStatus,
  ServerPluginLifecycleHook,
} from '@core/plugin-sdk'
import {
  loadPluginModulePack,
  loadPluginServerEntrypoint,
  primePluginSettingsCache,
  runPluginLifecycle,
  unloadPlugin,
} from '../../../plugins/runtime'
import {
  activateSandboxedPluginModulePack,
  deactivatePluginModulePack,
} from '@core/plugins/modulePackLoader'
import type { CmsHandlerOptions } from '../shared'
import { lifecycleErrorMessage, pluginManifestWithGrants } from './shared'

interface LifecycleHookResult {
  plugin: InstalledPlugin
  ok: boolean
}

export async function runPluginLifecycleHook(
  db: DbClient,
  plugin: InstalledPlugin,
  options: CmsHandlerOptions,
  hook: Exclude<ServerPluginLifecycleHook, 'migrate'>,
  successStatus: PluginLifecycleStatus,
): Promise<LifecycleHookResult> {
  const manifest = pluginManifestWithGrants(plugin)

  try {
    // Make sure the plugin's settings cache is current before the worker
    // seeds them into its local mirror — the rows carry the canonical
    // values (non-secret settings + decrypted secrets) and any prior
    // in-process cache may be stale (e.g. after a settings PUT).
    await primePluginSettingsCache(db, plugin)

    // Canvas module pack — host-side, separate from worker. Activate when
    // entering active state; deactivate when leaving.
    if (
      hook === 'activate' &&
      manifest.entrypoints?.modules &&
      manifest.grantedPermissions?.includes('modules.register')
    ) {
      try {
        const pack = await loadPluginModulePack(manifest, options.uploadsDir)
        if (pack) activateSandboxedPluginModulePack(manifest, pack)
      } catch (err) {
        console.error(`[plugin:${plugin.id}] module pack activate failed`, err)
      }
    }
    if (hook === 'deactivate' || hook === 'uninstall') {
      deactivatePluginModulePack(plugin.id)
    }

    // Server entrypoint — load into the worker (no-op for declarative
    // plugins without `entrypoints.server`), then run the named hook.
    const loaded = await loadPluginServerEntrypoint(manifest, options.uploadsDir)
    if (loaded) {
      await runPluginLifecycle(db, plugin.id, hook)
    }

    // After deactivate / uninstall the plugin should not stay loaded in
    // the worker — drop it so a subsequent re-activate gets a fresh
    // module instance.
    if (hook === 'deactivate' || hook === 'uninstall') {
      await unloadPlugin(plugin.id)
    }

    const updatedResult = await setPluginLifecycleStatus(db, plugin.id, successStatus)
    const updated = updatedResult?.kind === 'ok' ? updatedResult.plugin : null
    return { plugin: updated ?? plugin, ok: true }
  } catch (err) {
    // Activate failure leaves us in a half-loaded state — drop the worker
    // entry and the canvas module pack so the next attempt starts clean.
    if (hook === 'activate') {
      try { await unloadPlugin(plugin.id) } catch { /* noop */ }
      deactivatePluginModulePack(plugin.id)
    }
    const updatedResult = await setPluginLifecycleStatus(db, plugin.id, 'error', lifecycleErrorMessage(err))
    const updated = updatedResult?.kind === 'ok' ? updatedResult.plugin : null
    return { plugin: updated ?? plugin, ok: false }
  }
}
