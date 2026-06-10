/**
 * Plugin state-mutation routes — flip enabled, uninstall, restart.
 *
 *   PATCH  /admin/api/cms/plugins/:id            — enable / disable
 *   DELETE /admin/api/cms/plugins/:id            — uninstall + delete on-disk assets
 *   POST   /admin/api/cms/plugins/:id/restart    — manual restart for a parked plugin
 *
 * Every route runs the matching lifecycle hook (`activate`, `deactivate`,
 * `uninstall`), broadcasts the event, and emits one audit record. The
 * uninstall route additionally removes the on-disk asset dir and re-activates
 * the surviving plugins so they pick their hooks back up.
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
import { type CmsHandlerOptions } from '../shared'
import {
  lifecycleErrorMessage,
  maskPluginSecrets,
  pluginNotFound,
  pluginsPayload,
  recordPluginAuditEvent,
  removePluginAssets,
  removePluginVersionAssets,
} from './shared'
import { runPluginLifecycleHook } from './lifecycle'

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
  return jsonResponse({ plugin: maskPluginSecrets(lifecycle.plugin), ...(await pluginsPayload(db)) })
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
    const lookup = await getInstalledPlugin(db, pluginId)
    if (!lookup) return pluginNotFound()

    if (lookup.kind === 'broken') {
      // Manifest is corrupt — skip lifecycle hooks (no valid plugin to uninstall).
      // Delete the DB row and do a best-effort asset removal using the version
      // stored in the row's own columns (reliable even when manifest_json is broken).
      const deleted = await deletePlugin(db, pluginId)
      if (!deleted) return pluginNotFound()
      if (options.uploadsDir) {
        await removePluginVersionAssets(options.uploadsDir, lookup.id, lookup.version)
      }
      await activateInstalledServerPlugins(db, options.uploadsDir)
      await recordPluginAuditEvent(db, user, req, 'plugin.delete', lookup.id)
      broadcastPluginEvent({
        kind: 'uninstalled',
        pluginId: lookup.id,
        occurredAt: new Date().toISOString(),
      })
      return jsonResponse({ ok: true })
    }

    const current = lookup.plugin
    const lifecycle = await runPluginLifecycleHook(db, current, options, 'uninstall', current.lifecycleStatus)
    if (!lifecycle.ok) {
      return badRequest(lifecycle.plugin.lastError ?? 'Plugin uninstall failed')
    }

    const deleted = await deletePlugin(db, pluginId)
    if (!deleted) return pluginNotFound()
    await unloadPlugin(pluginId)
    await removePluginAssets(current, options.uploadsDir)
    await activateInstalledServerPlugins(db, options.uploadsDir)
    await recordPluginAuditEvent(db, user, req, 'plugin.delete', pluginId)
    broadcastPluginEvent({
      kind: 'uninstalled',
      pluginId,
      occurredAt: new Date().toISOString(),
    })
    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
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
  return jsonResponse({ plugin: maskPluginSecrets(finalRow), ...(await pluginsPayload(db)) })
}
