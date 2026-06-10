/**
 * Plugin state-mutation routes — flip enabled, uninstall, restart.
 *
 *   PATCH  /admin/api/cms/plugins/:id              — enable / disable
 *   DELETE /admin/api/cms/plugins/:id[?force=true] — uninstall + delete on-disk assets
 *   POST   /admin/api/cms/plugins/:id/restart      — manual restart for a parked plugin
 *
 * Every route runs the matching lifecycle hook (`activate`, `deactivate`,
 * `uninstall`), broadcasts the event, and emits one audit record. The
 * uninstall route runs `deactivate` first when the plugin is active, then
 * `uninstall`; `?force=true` skips the hooks entirely (the escape hatch for
 * a throwing or unloadable hook). All uninstall variants — normal, forced,
 * corrupt-manifest — converge on one teardown (`removePluginCompletely`)
 * that drops the worker, the DB row, crash bookkeeping, schedule run
 * history, and the plugin's whole on-disk tree, then re-activates the
 * surviving plugins so they pick their hooks back up.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import {
  deletePlugin,
  getInstalledPlugin,
  clearPluginCrashes,
  setPluginEnabled,
  setPluginLifecycleStatus,
} from '../../../repositories/plugins'
import {
  activateInstalledServerPlugins,
  clearPluginCrashCounter,
  reloadAndActivatePlugin,
  unloadPlugin,
} from '../../../plugins/runtime'
import { broadcastPluginEvent } from '../../../plugins/eventBroadcaster'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { deactivatePluginModulePack } from '@core/plugins/modulePackLoader'
import { clearPluginScheduleRuns } from '../../../repositories/pluginSchedules'
import { type CmsHandlerOptions } from '../shared'
import {
  lifecycleErrorMessage,
  presentPluginSecrets,
  pluginNotFound,
  pluginsPayload,
  recordPluginAuditEvent,
  removeAllPluginAssets,
} from './shared'
import { runPluginLifecycleHook } from './lifecycle'
import type { InstalledPlugin } from '@core/plugin-sdk'

/**
 * PATCH `enabled` on a single plugin. Both branches flip the enabled flag,
 * run the matching lifecycle hook, re-bind the runtime registry, and emit
 * one audit event — only the verbs and statuses differ.
 */
async function setPluginEnabledFromRequest(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
  enabled: boolean,
): Promise<Response> {
  const updatedResult = await setPluginEnabled(db, pluginId, enabled)
  if (!updatedResult) return pluginNotFound()
  // This shouldn't happen (we already rejected broken plugins before calling
  // this helper), but guard defensively in case a concurrent mutation raced.
  if (updatedResult.kind === 'broken') {
    return jsonResponse(
      { error: 'Cannot modify a plugin with a corrupt manifest — remove and reinstall it.' },
      { status: 409 },
    )
  }
  const updated = updatedResult.plugin

  await unloadPlugin(pluginId)
  const lifecycle = await runPluginLifecycleHook(
    db,
    updated,
    options,
    enabled ? 'activate' : 'deactivate',
    enabled ? 'active' : 'disabled',
  )

  // Disabling a plugin frees its registry slot but leaves the rest of the
  // installed surface registered — re-activate the others so they pick up
  // their hooks again.
  if (!enabled) {
    await activateInstalledServerPlugins(db, options.uploadsDir)
  }

  broadcastPluginEvent({
    kind: enabled ? 'enabled' : 'disabled',
    pluginId,
    occurredAt: new Date().toISOString(),
  })
  await recordPluginAuditEvent(
    db,
    user,
    req,
    enabled ? 'plugin.enable' : 'plugin.disable',
    pluginId,
  )
  return jsonResponse({ plugin: await presentPluginSecrets(db, lifecycle.plugin), ...(await pluginsPayload(db)) })
}

export async function handlePluginItem(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
): Promise<Response> {
  if (req.method === 'PATCH') {
    const PluginEnabledBodySchema = Type.Object({ enabled: Type.Boolean() })
    const body = await readValidatedBody(req, PluginEnabledBodySchema)
    if (!body) return badRequest('Plugin enabled must be a boolean')

    const lookup = await getInstalledPlugin(db, pluginId)
    if (!lookup) return pluginNotFound()
    if (lookup.kind === 'broken') {
      return jsonResponse(
        { error: 'Cannot modify a plugin with a corrupt manifest — remove and reinstall it.' },
        { status: 409 },
      )
    }

    return setPluginEnabledFromRequest(req, db, options, user, pluginId, body.enabled)
  }

  if (req.method === 'DELETE') {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const lookup = await getInstalledPlugin(db, pluginId)
    if (!lookup) return pluginNotFound()

    // Lifecycle hooks run only on the normal path with a parseable manifest:
    // `?force=true` is the operator's escape hatch for a throwing or
    // unloadable hook, and a corrupt manifest has no valid plugin to run
    // hooks on. Both skip straight to teardown.
    if (!force && lookup.kind === 'ok') {
      let current = lookup.plugin
      // Uninstall contract: "(if active) deactivate → uninstall". Run
      // deactivate first so the plugin tears down its active-state
      // resources before the uninstall hook does its permanent cleanup.
      if (current.lifecycleStatus === 'active') {
        const deactivated = await runPluginLifecycleHook(db, current, options, 'deactivate', 'disabled')
        if (!deactivated.ok) return uninstallHookFailure('deactivate', deactivated.plugin)
        current = deactivated.plugin
      }
      const uninstalled = await runPluginLifecycleHook(db, current, options, 'uninstall', current.lifecycleStatus)
      if (!uninstalled.ok) return uninstallHookFailure('uninstall', uninstalled.plugin)
    }

    return removePluginCompletely(req, db, options, user, pluginId, force)
  }

  return methodNotAllowed()
}

/**
 * 400 for a lifecycle hook that threw during a normal uninstall. The plugin
 * row survives (parked in `error` with `lastError` set by the hook runner);
 * the message tells the operator the force-remove escape hatch exists so a
 * broken hook can never permanently block removal.
 */
function uninstallHookFailure(
  hook: 'deactivate' | 'uninstall',
  plugin: InstalledPlugin,
): Response {
  const detail = plugin.lastError ?? 'Plugin lifecycle hook failed'
  return badRequest(
    `Plugin ${hook} hook failed during uninstall: ${detail} — the plugin is still installed. Fix the plugin, or force-remove it to skip its cleanup hooks.`,
  )
}

/**
 * The single uninstall teardown — every removal variant (normal after
 * successful hooks, `?force=true`, corrupt manifest) lands here. Drops the
 * DB row (settings live on it; records and schedules cascade via FK), the
 * worker, host-side canvas modules, crash bookkeeping and schedule run
 * history (neither has an FK, so they'd outlive the row without an explicit
 * sweep), and the plugin's whole `uploads/plugins/<id>/` tree — including
 * stale version dirs left behind by interrupted upgrades.
 */
async function removePluginCompletely(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
  forced: boolean,
): Promise<Response> {
  const deleted = await deletePlugin(db, pluginId)
  if (!deleted) return pluginNotFound()
  // Idempotent on the normal path (the uninstall hook runner already
  // unloaded the worker and deactivated the module pack) — required on the
  // force / corrupt-manifest paths, which skip the hook runner.
  await unloadPlugin(pluginId)
  deactivatePluginModulePack(pluginId)
  clearPluginCrashCounter(pluginId)
  await clearPluginCrashes(db, pluginId)
  await clearPluginScheduleRuns(db, pluginId)
  if (options.uploadsDir) {
    await removeAllPluginAssets(options.uploadsDir, pluginId)
  }
  await activateInstalledServerPlugins(db, options.uploadsDir)
  await recordPluginAuditEvent(
    db,
    user,
    req,
    'plugin.delete',
    pluginId,
    forced ? { forced: true } : {},
  )
  broadcastPluginEvent({
    kind: 'uninstalled',
    pluginId,
    occurredAt: new Date().toISOString(),
  })
  return jsonResponse({ ok: true })
}

/**
 * `POST /admin/api/cms/plugins/:id/restart`
 *
 * Manual restart for a plugin parked in `lifecycle_status='error'` after
 * its crash budget was exhausted (or whenever the operator wants to bounce
 * it). Resets the per-plugin sliding-window crash counter so the next
 * failure starts fresh, drops any stale crash events, then re-loads the
 * entrypoint into a new worker and runs `activate`.
 *
 * If activate succeeds the lifecycle row flips back to `active`. If it
 * fails the worker host's normal crash path takes over and the row stays
 * in `error` with the new failure recorded.
 */
export async function handlePluginRestart(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()
  const lookup = await getInstalledPlugin(db, pluginId)
  if (!lookup) return pluginNotFound()
  if (lookup.kind === 'broken') {
    return jsonResponse(
      { error: 'Cannot restart a plugin with a corrupt manifest — remove and reinstall it.' },
      { status: 409 },
    )
  }
  const plugin = lookup.plugin
  if (!plugin.enabled) return badRequest('Cannot restart a disabled plugin — enable it first.')

  // Reset the crash counter + clear historical crash events so the UI starts
  // fresh after the operator's intervention. Keeping old events around after
  // an explicit restart would muddy the "did the restart work?" signal.
  clearPluginCrashCounter(pluginId)
  await clearPluginCrashes(db, pluginId)

  // Fully unload first so the existing (possibly half-dead) worker is
  // terminated. Then reload + activate.
  await unloadPlugin(pluginId)
  try {
    await reloadAndActivatePlugin(db, pluginId, options.uploadsDir)
    await setPluginLifecycleStatus(db, pluginId, 'active')
  } catch (err) {
    const message = lifecycleErrorMessage(err)
    await setPluginLifecycleStatus(db, pluginId, 'error', message)
    return badRequest(`Restart failed: ${message}`)
  }

  await recordPluginAuditEvent(db, user, req, 'plugin.enable', pluginId, { restart: true })
  broadcastPluginEvent({
    kind: 'restarted',
    pluginId,
    occurredAt: new Date().toISOString(),
  })
  const finalResult = await getInstalledPlugin(db, pluginId)
  const finalRow = (finalResult?.kind === 'ok' ? finalResult.plugin : null) ?? plugin
  return jsonResponse({ plugin: await presentPluginSecrets(db, finalRow), ...(await pluginsPayload(db)) })
}
