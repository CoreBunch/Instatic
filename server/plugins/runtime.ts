/**
 * Plugin server-side runtime — orchestrates plugin lifecycle, route
 * forwarding, and asset path safety.
 *
 * As of the worker-isolation refactor, plugin server modules
 * (`entrypoints.server`) are loaded and executed in a separate Bun
 * `Worker` (see `pluginWorkerHost.ts` + `pluginWorker.ts`). The host
 * process never imports plugin code — eliminating the `bun --watch`
 * race during upgrade cleanup, isolating plugin crashes from the host,
 * and giving us a foundation to drop privileges (no fs / no env) inside
 * the worker in a future hardening pass.
 *
 * This module is the thin orchestration layer between the rest of the
 * CMS server and the worker host. It owns:
 *   - Path-containment safety (`assertPathWithin`)
 *   - The HTTP entrypoint for `/admin/api/cms/plugins/:id/runtime/...`
 *   - The boot-time activation loop
 *
 * The plugin settings cache (seeded into each worker's local `settings.get`
 * mirror at activation) lives in `settingsCache.ts`; the write-path sync
 * that pushes settings changes into running VMs lives in
 * `./host/settingsSync.ts`.
 *
 * Plugin canvas-module packs (`entrypoints.modules`) now run inside their
 * own QuickJS-WASM sandbox (`server/plugins/modulePackVm.ts`) — render
 * functions are sync-evaluated in the VM per page node so a malicious or
 * buggy pack cannot reach the host's filesystem, env, or network without
 * going through the gated SDK surface.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { assertPathWithin } from '../util/pathWithin'
import type { DbClient } from '../db/client'
import {
  getInstalledPlugin,
  listInstalledPlugins,
  recordPluginCrash,
  setPluginLifecycleStatus,
} from '../repositories/plugins'
import { disableSchedulesNotReclaimedSince } from '../repositories/pluginSchedules'
import type { PluginManifest } from '@core/plugin-sdk'
import { createModulePackVm, type ModulePackVm } from './modulePackVm'
import {
  activateSandboxedPluginModulePack,
  resetPluginModulePacks,
} from '@core/plugins/modulePackLoader'
import { jsonResponse } from '../http'
import { hookBus } from '@core/plugins/hookBus'
import { requireAuthenticatedUser, requireCapability } from '../auth/authz'
import { clearPluginCrashCounter, setCrashRecoveryHandler } from './host/crashRecovery'
import { setPluginWorkerDbClient } from './host/registry'
import {
  findPluginRouteAccess,
  loadPluginInWorker,
  runLifecycleInWorker,
  runMigrateInWorker,
  runRouteInWorker,
  unloadPluginInWorker,
} from './host/rpc'
import { dispatchApiCall } from './host/apiDispatch'
import { workerCallError } from './host/workerErrors'
import { resetPluginWorker, setApiCallDispatcher } from './host/workerPool'
import { broadcastPluginEvent } from './eventBroadcaster'
import {
  dropCachedPluginSettings,
  getCachedPluginSettings,
  primePluginSettingsCache,
} from './settingsCache'

setApiCallDispatcher(dispatchApiCall)

// Re-export for callers that orchestrate manual restart (resets the
// per-plugin crash counter so the next failure starts a fresh budget).
export { clearPluginCrashCounter }

// Re-export the host's setter so the server entry point can wire in the
// DbClient at boot before any request arrives.
export { setPluginWorkerDbClient }

// Settings cache lives in `settingsCache.ts` — the cached record merges the
// decrypted secret settings (plugin_secrets) over `plugin.settings`, and is
// re-exported here for the lifecycle orchestration call sites below.
export { primePluginSettingsCache }


// ---------------------------------------------------------------------------
// Plugin lifecycle helpers — wrappers around the worker host that resolve
// the on-disk entrypoint path safely. Callers in `plugins.ts` use these
// to load + run individual lifecycle hooks during install / upgrade /
// disable / uninstall flows.
// ---------------------------------------------------------------------------

interface ResolvedEntrypoint {
  entryPath: string
}

function resolvePluginServerEntrypoint(
  manifest: PluginManifest,
  uploadsDir: string,
): ResolvedEntrypoint | null {
  if (!manifest.assetBasePath || !manifest.entrypoints?.server) return null
  const relativeBase = manifest.assetBasePath.replace(/^\/uploads\/?/, '')
  const entryPath = join(uploadsDir, relativeBase, manifest.entrypoints.server)
  assertPathWithin(uploadsDir, entryPath)
  return { entryPath }
}

/**
 * Load a plugin's server entrypoint into the worker. Returns `false` if
 * the plugin has no server entrypoint (declarative-only plugins are
 * skipped). Throws if the worker reports a load error so callers can
 * propagate the message into the lifecycle status row.
 */
export async function loadPluginServerEntrypoint(
  manifest: PluginManifest,
  uploadsDir?: string,
): Promise<boolean> {
  if (!uploadsDir) return false
  const resolved = resolvePluginServerEntrypoint(manifest, uploadsDir)
  if (!resolved) return false
  const result = await loadPluginInWorker({
    manifest,
    entryFileUrl: resolved.entryPath,
    settings: getCachedPluginSettings(manifest.id),
  })
  if (!result.ok) {
    throw workerCallError(result.error ?? `Failed to load plugin "${manifest.id}" in worker`, result.stack)
  }
  return true
}

/**
 * Run a single lifecycle hook on a previously-loaded plugin. No-op if
 * the hook isn't exported by the plugin module.
 *
 * After a successful `activate` pass this also runs the schedule ghost
 * sweep: any schedule row of this plugin that was NOT re-registered during
 * the pass (its `claimed_at` predates the pass) is disabled. Without the
 * sweep, a schedule dropped by a plugin upgrade keeps firing forever
 * against a handler that no longer exists in the VM.
 */
export async function runPluginLifecycle(
  db: DbClient,
  pluginId: string,
  hook: 'install' | 'activate' | 'deactivate' | 'uninstall',
): Promise<void> {
  const startedAtIso = new Date().toISOString()
  await runLifecycleInWorker(pluginId, hook)
  if (hook === 'activate') {
    await disableSchedulesNotReclaimedSince(db, pluginId, startedAtIso)
  }
}

/**
 * Run the `migrate` hook on a previously-loaded plugin. The host calls
 * this in the upgrade flow between the old version's deactivate and the
 * new version's activate.
 */
export async function runPluginMigrate(
  pluginId: string,
  fromVersion: string,
): Promise<void> {
  await runMigrateInWorker(pluginId, fromVersion)
}

/**
 * Drop a plugin from the worker. Called after `deactivate` / `uninstall`
 * lands. Forgets host-side route + hook + loop registrations as a side
 * effect.
 */
export async function unloadPlugin(pluginId: string): Promise<void> {
  dropCachedPluginSettings(pluginId)
  await unloadPluginInWorker(pluginId)
}

// ---------------------------------------------------------------------------
// Module pack loader (canvas modules) — SANDBOXED
// ---------------------------------------------------------------------------

/**
 * Load a plugin's canvas module pack into a QuickJS-WASM sandbox. The
 * publisher's render hot path goes through `vm.render(moduleId, props,
 * children)` which sync-evals the plugin's render function inside the
 * sandbox — no host-process side effects, no Bun/Node ambient access.
 *
 * The previous implementation used `await import(dataUrl)` which ran the
 * pack in the host process. That was a complete RCE bypass — a malicious
 * plugin could put its payload in `entrypoints.modules` and skip the
 * server-entrypoint sandbox entirely. This call closes that hole.
 */
export async function loadPluginModulePack(
  manifest: PluginManifest,
  uploadsDir?: string,
): Promise<ModulePackVm | null> {
  if (!uploadsDir || !manifest.assetBasePath || !manifest.entrypoints?.modules) return null
  const relativeBase = manifest.assetBasePath.replace(/^\/uploads\/?/, '')
  const entryPath = join(uploadsDir, relativeBase, manifest.entrypoints.modules)
  assertPathWithin(uploadsDir, entryPath)
  const packSource = await readFile(entryPath, 'utf-8')
  return await createModulePackVm({ pluginId: manifest.id, packSource })
}

// ---------------------------------------------------------------------------
// HTTP runtime forwarder — `/admin/api/cms/plugins/:id/runtime/...`
// ---------------------------------------------------------------------------

export async function handleServerPluginRuntimeRequest(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const url = new URL(req.url)
  const match = url.pathname.match(/^\/admin\/api\/cms\/plugins\/([^/]+)\/runtime(\/.*)?$/)
  if (!match) return null

  const pluginId = decodeURIComponent(match[1])
  const routePath = decodeURIComponent(match[2] ?? '/')

  const route = findPluginRouteAccess(pluginId, req.method, routePath)
  if (!route) return jsonResponse({ error: 'Plugin route not found' }, { status: 404 })

  // Access gate stays host-side. The plugin route handler in the worker
  // still receives the validated user object (or null for public routes)
  // so it can do additional fine-grained checks if needed.
  //
  //   capability    Caller needs the named core capability.
  //   authenticated Caller needs a valid session — any logged-in user.
  //   public        Anonymous-callable; no auth check. Plugin must hold
  //                 the `cms.routes.public` permission to register one.
  let user: Awaited<ReturnType<typeof requireCapability>> | Response | null
  switch (route.access.kind) {
    case 'capability':
      user = await requireCapability(req, db, route.access.capability)
      if (user instanceof Response) return user
      break
    case 'authenticated':
      user = await requireAuthenticatedUser(req, db)
      if (user instanceof Response) return user
      break
    case 'public':
      user = null
      break
  }

  return await runRouteInWorker({
    pluginId,
    method: req.method,
    path: routePath,
    request: req,
    user: user
      ? { id: user.id, email: user.email, capabilities: user.capabilities }
      : null,
  })
}

// ---------------------------------------------------------------------------
// Boot-time activation
// ---------------------------------------------------------------------------

/**
 * Re-load + re-activate a single plugin from disk. Used by the crash
 * recovery handler (after a worker auto-respawn) and by the manual
 * "Restart Plugin" admin endpoint.
 */
export async function reloadAndActivatePlugin(
  db: DbClient,
  pluginId: string,
  uploadsDir?: string,
): Promise<void> {
  if (!uploadsDir) return
  const result = await getInstalledPlugin(db, pluginId)
  // Broken manifest or not found: nothing safe to reload. Callers that need
  // to distinguish these cases (e.g. the restart handler) check the result
  // before calling this helper.
  if (!result || result.kind !== 'ok' || !result.plugin.enabled) return
  const { plugin } = result
  const manifest: PluginManifest = {
    ...plugin.manifest,
    grantedPermissions: plugin.grantedPermissions,
  }
  if (!manifest.assetBasePath) return
  // Refresh the in-memory settings cache from the canonical rows (including
  // decrypted secrets) before the worker mirror gets seeded — keeps the
  // worker in sync if settings drifted since the last activation.
  await primePluginSettingsCache(db, plugin)
  if (manifest.entrypoints?.server) {
    const loaded = await loadPluginServerEntrypoint(manifest, uploadsDir)
    if (loaded) await runPluginLifecycle(db, manifest.id, 'activate')
  }
}

/**
 * Register the crash recovery handler with the worker host. Called from
 * `activateInstalledServerPlugins` so the host has a live `db + uploadsDir`
 * pair to reload plugins with after a crash. Each invocation replaces the
 * previous handler (idempotent — safe to call on every boot / re-bind).
 */
function registerCrashRecoveryHandler(db: DbClient, uploadsDir: string): void {
  setCrashRecoveryHandler(async ({ pluginId, reason, decision }) => {
    const occurredAt = new Date().toISOString()

    // Persist the crash event so the admin UI can show it. Best-effort —
    // a DB error here shouldn't block the recovery flow.
    try {
      await recordPluginCrash(db, {
        id: nanoid(),
        pluginId,
        reason,
      })
    } catch (err) {
      console.error(`[plugin:${pluginId}] failed to record crash event:`, err)
    }

    // Tell every connected admin client about the crash so toasts + nav
    // badge + open Plugins-page lists update in real time.
    broadcastPluginEvent({
      kind: 'crash',
      pluginId,
      reason,
      recentCrashCount: decision.recentCrashCount,
      occurredAt,
    })

    if (decision.kind === 'give-up') {
      // Crash budget exceeded — park the plugin in error state. The site
      // owner has to click "Restart Plugin" in the admin UI to reset the
      // counter and try again.
      console.error(
        `[plugin:${pluginId}] crashed ${decision.recentCrashCount} times in the last 5 minutes; parking in error state`,
      )
      await setPluginLifecycleStatus(
        db,
        pluginId,
        'error',
        `Crash budget exceeded (${decision.recentCrashCount} crashes in 5 min). Last reason: ${reason}`,
      )
      broadcastPluginEvent({
        kind: 'parked',
        pluginId,
        reason,
        recentCrashCount: decision.recentCrashCount,
        occurredAt,
      })
      return
    }

    // Within budget — auto-respawn. The worker host has already torn down
    // the dead worker; reloading spawns a fresh one and re-runs activate.
    console.warn(
      `[plugin:${pluginId}] crash #${decision.recentCrashCount} in window — auto-respawning. Last reason: ${reason}`,
    )
    try {
      await reloadAndActivatePlugin(db, pluginId, uploadsDir)
      broadcastPluginEvent({
        kind: 'recovered',
        pluginId,
        afterCrashCount: decision.recentCrashCount,
        occurredAt: new Date().toISOString(),
      })
    } catch (err) {
      // Re-activation itself failed. The next round-trip will record this
      // as another crash event via the worker's normal error path; if the
      // failure is repeatable the budget will be exceeded and the plugin
      // will park in error state on its own. Log here for ops visibility.
      console.error(`[plugin:${pluginId}] auto-respawn re-activation failed:`, err)
    }
  })
}

export async function activateInstalledServerPlugins(
  db: DbClient,
  uploadsDir?: string,
): Promise<void> {
  if (!uploadsDir) return

  // Make sure the worker host can reach the DbClient — required before any
  // worker-initiated `cms.storage.*` round-trip lands. Idempotent; safe to
  // call on every boot.
  setPluginWorkerDbClient(db)
  registerCrashRecoveryHandler(db, uploadsDir)

  // Reset existing in-process state so a re-bind (from `bun --watch`
  // reload, dev-mode hot path, or a full restart) starts from a clean
  // slate. Worker is terminated and respawned on next call.
  await resetPluginWorker()
  resetPluginModulePacks()
  hookBus.reset()

  // Start the scheduler tick. Idempotent — a re-bind with the same
  // process keeps the existing interval pointed at the same DbClient.
  // (We deliberately do NOT stop and restart, to avoid the brief gap
  // where a scheduled fire could land on an unbound DbClient.)
  const { startScheduler } = await import('./scheduler')
  startScheduler(db)

  // Same idempotency contract as the plugin scheduler — boot path,
  // re-bind, hot reload all converge on a single running tick pointed
  // at the current DbClient.
  const { startPublishScheduler } = await import('../publish/publishScheduler')
  startPublishScheduler(db, uploadsDir)

  const results = await listInstalledPlugins(db)
  for (const result of results) {
    // Phase: manifest-validation — the stored manifest_json failed to parse.
    // Mark the plugin as broken in the DB so the admin UI surfaces the error,
    // then skip to the next plugin.  All other enabled plugins continue to
    // activate normally.
    if (result.kind === 'broken') {
      console.error(`[plugin:${result.id}] boot manifest-validation failed: ${result.reason}`)
      try {
        await setPluginLifecycleStatus(db, result.id, 'error', result.reason)
      } catch (dbErr) {
        console.error(`[plugin:${result.id}] failed to persist boot manifest error:`, dbErr)
      }
      continue
    }

    const { plugin } = result
    if (!plugin.enabled) continue
    const manifest: PluginManifest = {
      ...plugin.manifest,
      grantedPermissions: plugin.grantedPermissions,
    }
    if (!manifest.assetBasePath) continue

    // Settings cache must be populated BEFORE the worker loads the plugin
    // — `loadPluginInWorker` reads the cached record (non-secret settings +
    // decrypted secrets) to seed the worker's local `settings.get` mirror,
    // which plugin code may consult synchronously during `activate()`.
    await primePluginSettingsCache(db, plugin)

    // Phase: module-pack-load — registers canvas modules in the host registry
    // so server-rendered (publisher) and editor-rendered (canvas) pages can
    // use them immediately.  Failure is isolated: the server entrypoint can
    // still activate even if the pack fails.
    if (
      manifest.entrypoints?.modules &&
      plugin.grantedPermissions.includes('modules.register')
    ) {
      try {
        const pack = await loadPluginModulePack(manifest, uploadsDir)
        if (pack) activateSandboxedPluginModulePack(manifest, pack)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Module pack load failed'
        console.error(`[plugin:${manifest.id}] boot module-pack-load failed: ${message}`)
        try {
          await setPluginLifecycleStatus(db, manifest.id, 'error', message)
        } catch (dbErr) {
          console.error(`[plugin:${manifest.id}] failed to persist boot module-pack error:`, dbErr)
        }
      }
    }

    // Phase: server-entrypoint — load into worker, then run activate.
    if (manifest.entrypoints?.server) {
      try {
        const loaded = await loadPluginServerEntrypoint(manifest, uploadsDir)
        if (loaded) await runPluginLifecycle(db, manifest.id, 'activate')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server entrypoint activation failed'
        console.error(`[plugin:${manifest.id}] boot server-entrypoint failed: ${message}`)
        try {
          await setPluginLifecycleStatus(db, manifest.id, 'error', message)
        } catch (dbErr) {
          console.error(`[plugin:${manifest.id}] failed to persist boot entrypoint error:`, dbErr)
        }
      }
    }
  }
}
