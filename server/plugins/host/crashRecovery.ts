/**
 * Plugin worker teardown and recovery — sliding-window counters + auto-respawn.
 *
 * A worker is torn down for one of two causes (`WorkerTeardownCause`):
 *   - `crash`: it died, or stopped answering within the RPC timeout.
 *   - `overrun`: one of its calls ran out of its wall-clock budget. The
 *     handler cannot be cancelled inside the VM and would resume later and
 *     act after its caller was told it failed, so the host stops the whole
 *     worker instead (fail-stop) and starts a fresh one.
 *
 * Either way the plugin is re-loaded and re-activated, unless the cause has
 * repeated too often inside `TEARDOWN_WINDOW_MS`: then the host stops
 * respawning and parks the plugin in `lifecycle_status='error'`, and the site
 * owner has to click "Restart Plugin" to reset the counters and try again.
 */

import { loopSourceRegistry } from '@core/loops/registry'
import { hookBus } from '@core/plugins/hookBus'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
import { hostPlugins } from './registry'
import { workers, pendingRequests } from './workerState'
import type { CrashRecoveryDecision, CrashRecoveryHandler, WorkerTeardownCause } from './types'

/**
 * How many teardowns of one cause inside the window park the plugin. A crash
 * is a broken plugin: three is enough. An overrun is one slow call on a
 * plugin that otherwise works, and parking it takes every route and hook of
 * the plugin down, so it gets more room before the host gives up.
 */
const TEARDOWN_THRESHOLD: Record<WorkerTeardownCause, number> = { crash: 3, overrun: 5 }
const TEARDOWN_WINDOW_MS = 5 * 60 * 1000

/** Teardown timestamps within the current sliding window, oldest first, per cause. */
type TeardownTracker = Record<WorkerTeardownCause, number[]>

const teardownTrackers = new Map<string, TeardownTracker>()

/**
 * Reset a plugin's teardown counters. Called on a successful manual restart
 * and on uninstall.
 */
export function clearPluginCrashCounter(pluginId: string): void {
  teardownTrackers.delete(pluginId)
}

/**
 * Record a teardown in the per-plugin sliding window of its cause. Returns
 * whether the host should auto-respawn or give up.
 */
export function recordCrashAndDecide(
  pluginId: string,
  now: number = Date.now(),
  cause: WorkerTeardownCause = 'crash',
): CrashRecoveryDecision {
  const tracker = teardownTrackers.get(pluginId) ?? { crash: [], overrun: [] }
  const cutoff = now - TEARDOWN_WINDOW_MS
  // Drop expired entries before counting.
  tracker[cause] = tracker[cause].filter((t) => t > cutoff)
  tracker[cause].push(now)
  teardownTrackers.set(pluginId, tracker)

  const recentCrashCount = tracker[cause].length
  if (recentCrashCount >= TEARDOWN_THRESHOLD[cause]) {
    return { kind: 'give-up', recentCrashCount }
  }
  return { kind: 'respawn', recentCrashCount }
}

/**
 * A call was in flight on a worker the host restarted because ANOTHER call
 * overran its budget. Nothing is known about how far this one got: the caller
 * may retry (a route answers 503 with `Retry-After`).
 */
export class PluginWorkerRestartedError extends Error {
  constructor(pluginId: string) {
    super(`Plugin "${pluginId}" was restarted while this call was running. Try again.`)
    this.name = 'PluginWorkerRestartedError'
  }
}

/** Plugins torn down and not yet re-activated (or parked). */
const restartingPlugins = new Set<string>()

/**
 * True between a worker teardown and the end of its recovery. A route that
 * arrives in that gap finds no registered handler; the caller should be told
 * to retry, not that the route does not exist.
 */
export function isPluginRestarting(pluginId: string): boolean {
  return restartingPlugins.has(pluginId)
}

let crashRecoveryHandler: CrashRecoveryHandler | null = null

export function setCrashRecoveryHandler(handler: CrashRecoveryHandler): void {
  crashRecoveryHandler = handler
}

/**
 * Worker for `pluginId` died (uncaught error, RPC timeout) or must be
 * stopped (a call overran its budget). Reject only that plugin's pending RPCs; tear down host-side state for that plugin; drop the
 * worker reference so the next call respawns. Sibling plugins are
 * unaffected.
 *
 * After local cleanup, we record the crash in the per-plugin sliding-window
 * counter and hand off to the runtime layer (`crashRecoveryHandler`) which
 * decides whether to auto-respawn or park the plugin in `error` state. The
 * handler is responsible for: persisting the event to `plugin_crash_events`,
 * updating the lifecycle row, re-loading the plugin into a fresh worker.
 */
export function handleWorkerCrash(pluginId: string, reason: string, cause: WorkerTeardownCause = 'crash'): void {
  const w = workers.get(pluginId)
  if (w) {
    try { w.terminate() } catch {/* worker may already be dead */}
    workers.delete(pluginId)
  }
  for (const [correlationId, pending] of pendingRequests) {
    if (pending.pluginId !== pluginId) continue
    pendingRequests.delete(correlationId)
    pending.reject(
      cause === 'overrun'
        ? new PluginWorkerRestartedError(pluginId)
        : new Error(`Plugin "${pluginId}" worker crashed: ${reason}`),
    )
  }
  // Drop host-side bookkeeping for this plugin. Hook listeners + loop
  // sources registered via the dead worker would otherwise keep
  // round-tripping into nothing.
  const entry = hostPlugins.get(pluginId)
  if (entry) {
    for (const source of entry.loopSources) {
      loopSourceRegistry.unregister(source.sourceId)
    }
    // Abort every in-flight outbound fetch. The worker that requested them
    // is dead, so completing the response would just drop bytes on the
    // floor and tie up sockets/memory. Cancelling now releases them.
    for (const ctrl of entry.inflightFetches.values()) {
      try { ctrl.abort(new Error(`Plugin "${pluginId}" worker crashed`)) } catch { /* ignore */ }
    }
    entry.inflightFetches.clear()
    hookBus.unregisterPlugin(pluginId)
    mediaStorageRegistry.unregisterPlugin(pluginId)
    mediaVariantDelegateRegistry.unregisterPlugin(pluginId)
    hostPlugins.delete(pluginId)
  }

  const decision = recordCrashAndDecide(pluginId, Date.now(), cause)
  // Hand off to the runtime layer in a microtask — we don't want to block
  // the error event handler on async work, and re-loading the plugin needs
  // the current crash teardown to fully settle first.
  if (crashRecoveryHandler) {
    const handler = crashRecoveryHandler
    restartingPlugins.add(pluginId)
    queueMicrotask(() => {
      handler({ pluginId, reason, cause, decision })
        .catch((err: unknown) => {
          console.error(`[plugin:${pluginId}] crash recovery handler failed:`, err)
        })
        .finally(() => restartingPlugins.delete(pluginId))
    })
  }
}
