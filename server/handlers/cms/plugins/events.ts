/**
 * `GET /admin/api/cms/plugins/events` — Server-Sent Events stream of plugin
 * lifecycle events.
 *
 * Wired so each connected admin tab gets `crash`, `recovered`, `parked`,
 * `restarted`, `installed`, `updated`, `uninstalled`, `enabled`, and
 * `disabled` events in real time. The admin client uses these to:
 *   - re-fetch the plugins list (live update of the Plugins page),
 *   - push a toast on crash / parked events (visible from any admin route),
 *   - bump a red badge on the nav link when any plugin is in error state.
 *
 * Behaviour:
 *   - The auth gate (`plugins.read`) is applied by the dispatcher's
 *     `resolvePluginRoutePolicy` before we reach this handler.
 *   - Initial `event: ping` keeps proxies (vite, nginx) from idle-closing
 *     the long-lived connection. Followed by a periodic heartbeat every
 *     30s for the same reason.
 *   - Request abort and response-stream cancellation both unsubscribe from
 *     the broadcaster and stop the heartbeat. Bun reports a disconnected
 *     response consumer through `ReadableStream.cancel()` without necessarily
 *     aborting the server Request.
 *   - The stream never ends voluntarily — clients reconnect via the
 *     standard EventSource auto-reconnect on transport errors.
 */
import { subscribePluginEvents } from '../../../plugins/eventBroadcaster'
import { methodNotAllowed } from '../../../http'

const STREAM_LEASE_MS = 120_000

export function handlePluginEventsStream(req: Request): Response {
  if (req.method !== 'GET') return methodNotAllowed()
  const encoder = new TextEncoder()
  let closeStream: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let unsubscribe = (): void => {}
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let lease: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (lease) clearTimeout(lease)
        req.signal.removeEventListener('abort', cleanup)
        unsubscribe()
        try { controller.close() } catch { /* already closed or cancelled */ }
      }
      closeStream = cleanup

      function send(payload: string): void {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(payload))
        } catch {
          cleanup()
        }
      }

      // Subscribe to the broadcaster — every event becomes one SSE message.
      // SSE requires `data:` lines + a terminating blank line.
      unsubscribe = subscribePluginEvents((event) => {
        send(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
      })

      // Heartbeat keeps proxies + the EventSource itself happy. SSE comments
      // (`: heartbeat`) are ignored by the client but reset idle timers.
      heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`)
      }, 30_000)
      // Bound orphan lifetime even when an intermediary fails to propagate a
      // downstream disconnect. EventSource reconnects automatically.
      lease = setTimeout(cleanup, STREAM_LEASE_MS)

      if (req.signal.aborted) cleanup()
      else req.signal.addEventListener('abort', cleanup, { once: true })

      // Initial ping so the client sees a successful connection immediately,
      // even before the first real event arrives.
      send(`event: ping\ndata: connected\n\n`)
    },
    cancel() {
      closeStream?.()
      closeStream = null
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}
