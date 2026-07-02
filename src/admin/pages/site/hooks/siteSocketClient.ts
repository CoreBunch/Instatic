/**
 * siteSocketClient — the live-pull TRANSPORT of the multi-admin sync channel
 * (level B of the live-sync plan). Lazy-imported by `useSiteSocket` so the
 * whole sync machinery (event schemas, merge policy, snapshot fetching)
 * stays out of the site route's first-paint chunk.
 *
 * One WebSocket to `/admin/api/cms/site-socket` with exponential-backoff
 * reconnect. On every (re)connect it sends the store's seq cursor and the
 * server replies with the missed delta as ordinary events — the socket is a
 * HINT channel; the delta query is the truth, so dropped events can never
 * cause drift (self-healing by design).
 *
 * Incoming frames are TypeBox-validated (malformed frames are logged and
 * dropped) and processed strictly in arrival order through one promise
 * chain — a fetch for event N never interleaves with the apply of event
 * N+1. What an event DOES to the store is the merge policy in
 * `siteSyncMerge.ts`.
 */
import { SITE_SOCKET_PATH, SiteSyncEventSchema } from '@core/persistence/syncEvents'
import { safeParseJson } from '@core/utils/jsonValidate'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import { processSiteSyncEvent } from './siteSyncMerge'

const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

/**
 * Open (and own) the live-sync socket. Returns the disposer that tears the
 * connection down and stops reconnecting.
 */
export function connectSiteSocket(): () => void {
  let socket: WebSocket | null = null
  let disposed = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  function scheduleReconnect() {
    if (disposed) return
    // Exponential backoff with jitter, capped — the delta-on-reconnect
    // protocol makes aggressive retry unnecessary.
    const delay =
      Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempts) +
      Math.random() * 500
    attempts += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  function connect() {
    if (disposed) return
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${protocol}://${window.location.host}${SITE_SOCKET_PATH}`)

    socket.onopen = () => {
      attempts = 0
      socket?.send(
        JSON.stringify({ kind: 'subscribe', cursor: useEditorStore.getState().syncCursor }),
      )
    }

    socket.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== 'string') return // binary frames are not part of the protocol
      const parsed = safeParseJson(msg.data, SiteSyncEventSchema)
      if (!parsed.ok) {
        console.warn('[siteSocketClient] dropping malformed sync event')
        return
      }
      const event = parsed.value
      chain = chain.then(() =>
        processSiteSyncEvent(event).catch((err) => {
          console.error(
            '[siteSocketClient] failed to apply sync event:',
            getErrorMessage(err, 'unknown error'),
            err,
          )
        }),
      )
    }

    // Errors always surface as a close — reconnect is scheduled there.
    socket.onerror = () => {}

    socket.onclose = () => {
      socket = null
      scheduleReconnect()
    }
  }

  connect()

  return () => {
    disposed = true
    clearTimeout(reconnectTimer)
    if (socket) {
      // Detach first — the close handler would otherwise schedule a
      // reconnect for a socket we are deliberately tearing down.
      socket.onclose = null
      socket.close()
    }
  }
}
