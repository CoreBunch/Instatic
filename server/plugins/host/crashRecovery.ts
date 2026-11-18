/**
 * Plugin worker teardown and recovery — auto-respawn, and a sliding-window
 * crash counter.
 *
 * A worker is torn down for one of two causes (`WorkerTeardownCause`):
 *   - `crash`: it died, stopped answering within the RPC timeout, or could
 *     not finish a lifecycle call (load, activate, migrate) in time.
 *   - `overrun`: one of its other calls ran out of its wall-clock budget. The
 *     handler cannot be cancelled inside the VM and would resume later and
 *     act after its caller was told it failed, so the host stops the whole
 *     worker instead (fail-stop) and starts a fresh one.
 *
 * Either way the plugin is re-loaded and re-activated. Only crashes can park
 * a plugin: `CRASH_THRESHOLD` of them inside `CRASH_WINDOW_MS` and the host
 * stops respawning and sets `lifecycle_status='error'` until the site owner
 * clicks "Restart Plugin". An overrun never parks: a visitor who can reach a
 * public route can cause one, and must not be able to switch a plugin off.
 * A dispatch that keeps overrunning is held back for a while instead
 * (`dispatchCoolOff.ts`).
 */

import { loopSourceRegistry } from '@core/loops/registry'
import { hookBus } from '@core/plugins/hookBus'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
import { hostPlugins } from './registry'
import { clearDispatchCoolOffs } from './dispatchCoolOff'
import { beginOutputPluginRecovery } from './outputWatch'
import { workers, pendingRequests } from './workerState'
import type { CrashRecoveryDecision, CrashRecoveryHandler, WorkerTeardownCause } from './types'

/**
 * Crash threshold: if a plugin's worker crashes this many times within
 * CRASH_WINDOW_MS, the host stops auto-respawning and parks the plugin in
 * `lifecycle_status='error'`. The site owner has to click "Restart Plugin"
 * to reset the counter and try again.
 */
const CRASH_THRESHOLD = 3
const CRASH_WINDOW_MS = 5 * 60 * 1000

/** Teardown timestamps within the current sliding window, oldest first, per cause. */
type TeardownTracker = Record<WorkerTeardownCause, number[]>

const teardownTrackers = new Map<string, TeardownTracker>()

/**
 * Reset a plugin's teardown counters and route cool-offs. Called on a
 * successful manual restart and on uninstall.
 */
export function clearPluginCrashCounter(pluginId: string): void {
  teardownTrackers.delete(pluginId)
  clearDispatchCoolOffs(pluginId)
}

/**
 * Record a teardown in the per-plugin sliding window of its cause. Returns
 * whether the host should auto-respawn or give up. Only a crash can give up;
 * an overrun is counted (the admin shows the number) and always respawns.
 */
export function recordCrashAndDecide(
  pluginId: string,
  now: number = Date.now(),
  cause: WorkerTeardownCause = 'crash',
): CrashRecoveryDecision {
  const tracker = teardownTrackers.get(pluginId) ?? { crash: [], overrun: [] }
  const cutoff = now - CRASH_WINDOW_MS
  // Drop expired entries before counting.
  tracker[cause] = tracker[cause].filter((t) => t > cutoff)
  tracker[cause].push(now)
  teardownTrackers.set(pluginId, tracker)

  const recentCrashCount = tracker[cause].length
  if (cause === 'crash' && recentCrashCount >= CRASH_THRESHOLD) {
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

/**
 * Recoveries in progress per plugin. A count, not a flag: a second teardown
 * can start while the first recovery is still running, and the first one
 * finishing must not report the plugin as back.
 */
const recoveriesInProgress = new Map<string, number>()

/**
 * True between a worker teardown and the end of its recovery. A route that
 * arrives in that gap finds no registered handler; the caller should be told
 * to retry, not that the route does not exist.
 */
export function isPluginRestarting(pluginId: string): boolean {
  return (recoveriesInProgress.get(pluginId) ?? 0) > 0
}

/** The newest recovery started for each plugin. */
const recoveryGenerations = new Map<string, number>()

/**
 * True when `generation` is still the newest recovery of `pluginId`. A
 * recovery that finishes after a later teardown has been overtaken: the
 * later one decides what the plugin's status is.
 */
export function isLatestRecovery(pluginId: string, generation: number): boolean {
  return recoveryGenerations.get(pluginId) === generation
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
  // Stamped now, synchronously, so a recovery still running for an earlier
  // teardown can tell it has been overtaken before it writes anything.
  const generation = (recoveryGenerations.get(pluginId) ?? 0) + 1
  recoveryGenerations.set(pluginId, generation)
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
  // A plugin that feeds rendered output is missing from every render until
  // it is back: whatever caches or bakes a render must know (`outputWatch.ts`).
  const feedsOutput = entry !== undefined && (
    entry.hookListeners.length > 0 ||
    entry.hookFilters.length > 0 ||
    entry.loopSources.length > 0 ||
    entry.mediaAdapters.length > 0 ||
    entry.mediaUrlTransformers.length > 0
  )
  const outputRecovered = feedsOutput ? beginOutputPluginRecovery(pluginId) : undefined
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
  if (!crashRecoveryHandler) outputRecovered?.()
  if (crashRecoveryHandler) {
    const handler = crashRecoveryHandler
    recoveriesInProgress.set(pluginId, (recoveriesInProgress.get(pluginId) ?? 0) + 1)
    queueMicrotask(() => {
      handler({ pluginId, reason, cause, decision, generation })
        .catch((err: unknown) => {
          console.error(`[plugin:${pluginId}] crash recovery handler failed:`, err)
        })
        .finally(() => {
          outputRecovered?.()
          const left = (recoveriesInProgress.get(pluginId) ?? 1) - 1
          if (left > 0) recoveriesInProgress.set(pluginId, left)
          else recoveriesInProgress.delete(pluginId)
        })
    })
  }
}
