/**
 * Plugin event broadcaster — singleton fan-out from the host's plugin
 * lifecycle hooks (crash, recovered, parked, restarted, installed,
 * uninstalled, enabled, disabled) to subscribed admin clients via SSE.
 *
 * Subscribers register a callback through `subscribePluginEvents`; the
 * crash-recovery handler (and other lifecycle code paths) call
 * `broadcastPluginEvent` whenever something interesting happens. The SSE
 * endpoint (`/admin/api/cms/plugins/events`) wires one subscriber per
 * connected admin browser tab.
 *
 * Kept in a separate module from `pluginWorkerHost` so:
 *   1. The host has no opinion about how events are delivered.
 *   2. Tests can subscribe + assert on broadcasts without spinning up
 *      an SSE connection.
 *   3. Future delivery channels (websocket, in-process pub/sub for a
 *      future managed-mode message bus) plug in here without touching
 *      the worker host.
 *
 * Event shape is small + JSON-serializable. The client uses event kind
 * to decide what to do (toast / badge / live-list refresh).
 *
 * The payload shape is defined once as a TypeBox schema in
 * `@core/plugins/events` — the admin client validates every SSE frame
 * against it. Both sides share that one source of truth.
 */

import type { PluginEvent } from '@core/plugins/events'

type PluginEventListener = (event: PluginEvent) => void

const listeners = new Set<PluginEventListener>()

/**
 * Subscribe to plugin events. Returns an unsubscribe function. Call it
 * when the SSE connection (or test subscriber) goes away.
 */
export function subscribePluginEvents(listener: PluginEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Fire an event to every current subscriber. A throwing listener is
 * caught + logged; the others still run.
 */
export function broadcastPluginEvent(event: PluginEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[plugin-events] subscriber threw:', err)
    }
  }
}

