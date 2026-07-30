/**
 * Where the collab WebSocket dials.
 *
 * PRODUCTION is same-origin: the Bun server serves the admin bundle and the
 * socket, so `window.location.host` is already correct.
 *
 * VITE DEV cannot be same-origin. `scripts/vite.ts` runs Vite inside Bun, and
 * Bun's `node:http` ClientRequest never emits 'upgrade' — a 101 from the CMS
 * reaches Vite's proxy as an ordinary response, takes the non-upgrade
 * fallback, and the browser socket never completes (it hangs in
 * `readyState 0` forever, so the provider never even reaches its reconnect
 * path). When that connection later ends, the proxy calls
 * `socket.destroySoon()`, which Bun's socket does not implement, and the
 * uncaught TypeError kills the whole `bun run dev` process. So the socket
 * skips Vite entirely and dials the CMS port directly.
 *
 * The HOSTNAME is deliberately preserved and only the PORT is swapped. The
 * session cookie is `Path=/admin; HttpOnly; SameSite=Lax` and a WebSocket
 * handshake is not a top-level navigation, so a handshake the browser judges
 * to be third-party would drop the cookie and the upgrade would 401 into an
 * endless reconnect. The port is not part of that judgement, but the host is
 * — `localhost` and `127.0.0.1` count as different hosts, and `bun run dev`
 * serves Vite on `127.0.0.1` while developers routinely type `localhost`.
 * Rewriting the host to a literal would break exactly one of those two,
 * intermittently. Keeping `location.hostname` is what makes both work.
 */
import { SITE_SOCKET_PATH } from '@core/collab'

/** The subset of `window.location` the URL depends on. */
export interface CollabSocketLocation {
  protocol: string
  host: string
  hostname: string
}

/**
 * @param devCmsPort The CMS server's port when running under the Vite dev
 *   server, or `null` for the same-origin production case.
 */
export function collabSocketUrl(
  location: CollabSocketLocation,
  devCmsPort: string | null,
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const authority = devCmsPort === null ? location.host : `${location.hostname}:${devCmsPort}`
  return `${scheme}://${authority}${SITE_SOCKET_PATH}`
}
