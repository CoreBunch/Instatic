/**
 * Plugin worker crash recovery — sliding-window counter + auto-respawn.
 *
 * If a plugin's worker crashes this many times within CRASH_WINDOW_MS, the
 * host stops auto-respawning and parks the plugin in `lifecycle_status='error'`.
 * The site owner has to click "Restart Plugin" to reset the counter and try
 * again.
 */

import { loopSourceRegistry } from '@core/loops/registry'
import { hookBus } from '@core/plugins/hookBus'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
import { hostPlugins } from './registry'
import { workers, pendingRequests } from './workerState'
import type { CrashRecoveryDecision, CrashRecoveryHandler } from './types'

/**
 * Crash threshold: if a plugin's worker crashes this many times within
 * CRASH_WINDOW_MS, the host stops auto-respawning and parks the plugin in
 * `lifecycle_status='error'`. The site owner has to click "Restart Plugin"
 * to reset the counter and try again.
 */
const CRASH_THRESHOLD = 3
const CRASH_WINDOW_MS = 5 * 60 * 1000

interface CrashTracker {
  /** Crash timestamps within the current sliding window, oldest first. */
  timestamps: number[]
}

const crashTrackers = new Map<string, CrashTracker>()

/**
 * Reset a plugin's crash counter. Called on a successful manual restart and
 * on uninstall.
 */
export function clearPluginCrashCounter(pluginId: string): void {
  crashTrackers.delete(pluginId)
}

/**
 * Record a crash in the per-plugin sliding window. Returns whether the host
 * should auto-respawn or give up.
 */
export function recordCrashAndDecide(pluginId: string, now: number = Date.now()): CrashRecoveryDecision {
  const tracker = crashTrackers.get(pluginId) ?? { timestamps: [] }
  const cutoff = now - CRASH_WINDOW_MS
  // Drop expired entries before counting.
  tracker.timestamps = tracker.timestamps.filter((t) => t > cutoff)
  tracker.timestamps.push(now)
  crashTrackers.set(pluginId, tracker)

  const recentCrashCount = tracker.timestamps.length
  if (recentCrashCount >= CRASH_THRESHOLD) {
    return { kind: 'give-up', recentCrashCount }
  }
  return { kind: 'respawn', recentCrashCount }
}

let crashRecoveryHandler: CrashRecoveryHandler | null = null

export function setCrashRecoveryHandler(handler: CrashRecoveryHandler): void {
  crashRecoveryHandler = handler
}

/**
 * Worker for `pluginId` died (uncaught error). Reject only that plugin's
 * pending RPCs; tear down host-side state for that plugin; drop the
 * worker reference so the next call respawns. Sibling plugins are
 * unaffected.
 *
 * After local cleanup, we record the crash in the per-plugin sliding-window
 * counter and hand off to the runtime layer (`crashRecoveryHandler`) which
 * decides whether to auto-respawn or park the plugin in `error` state. The
 * handler is responsible for: persisting the event to `plugin_crash_events`,
 * updating the lifecycle row, re-loading the plugin into a fresh worker.
 */
export function handleWorkerCrash(pluginId: string, reason: string): void {
  const w = workers.get(pluginId)
  if (w) {
    try { w.terminate() } catch {/* worker may already be dead */}
    workers.delete(pluginId)
  }
  for (const [correlationId, pending] of pendingRequests) {
    if (pending.pluginId !== pluginId) continue
    pendingRequests.delete(correlationId)
    pending.reject(new Error(`Plugin "${pluginId}" worker crashed: ${reason}`))
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

  const decision = recordCrashAndDecide(pluginId)
  // Hand off to the runtime layer in a microtask — we don't want to block
  // the error event handler on async work, and re-loading the plugin needs
  // the current crash teardown to fully settle first.
  if (crashRecoveryHandler) {
    const handler = crashRecoveryHandler
    queueMicrotask(() => {
      handler({ pluginId, reason, decision }).catch((err: unknown) => {
        console.error(`[plugin:${pluginId}] crash recovery handler failed:`, err)
      })
    })
  }
}
