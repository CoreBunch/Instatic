/**
 * Live editor bridge for MCP.
 *
 * Browser-execution tools (insert HTML, apply CSS, set tokens, manage pages,
 * content CRUD, …) have no server implementation — their logic runs in the
 * editor app against the live store. To let an external MCP client use them,
 * the editor holds a long-lived newline-delimited JSON stream open while
 * mounted. Its HTTP response is advertised as an event stream so reverse
 * proxies preserve incremental delivery. This module keeps one bridge per user
 * and workspace (the newest open instance wins) and lets the MCP server relay a
 * browser tool call to the correct workspace before awaiting its result.
 *
 * Reuses the chat bridge machinery wholesale: `createBridge` issues the
 * `AiBrowserBridge` (whose `callBrowser` resolves when the editor POSTs back to
 * the existing `/admin/api/ai/tool-result`), and `encodeStreamEvent` frames the
 * NDJSON the editor reads with `readNdjsonStream`.
 *
 * Security: the registry is keyed by `userId` + workspace scope, so an MCP
 * connector can only ever reach the open workspace of its OWN owner and a
 * content tool can never be dispatched to the site editor (or vice versa).
 */
import type { AiBrowserBridge, AiStreamEvent } from '../runtime/types'
import { createBridge, encodeStreamEvent } from '../runtime'

interface EditorBridgeEntry {
  bridgeId: string
  bridge: AiBrowserBridge
  destroy: () => void
}

export type EditorBridgeScope = 'site' | 'content'
/**
 * How long a stream may sit with NO tool traffic before the server drops it.
 * This is an IDLE lease: every relayed tool request re-arms it, so an active
 * batch is never cut mid-flight (a fixed lease used to kill the stream at
 * exactly two minutes, failing whichever tool call straddled the boundary).
 * Its purpose is bounding orphan lifetime when a proxy fails to propagate a
 * closed downstream connection; the client reconnect loop restores a
 * legitimately alive workspace within seconds of the drop.
 */
const STREAM_IDLE_LEASE_MS = 120_000

const byUser = new Map<string, Map<EditorBridgeScope, EditorBridgeEntry>>()

/** The live workspace bridge for a user and scope, or null when disconnected. */
export function getEditorBridgeForUser(
  userId: string,
  scope: EditorBridgeScope,
): AiBrowserBridge | null {
  return byUser.get(userId)?.get(scope)?.bridge ?? null
}

export function hasEditorBridge(userId: string, scope: EditorBridgeScope): boolean {
  return byUser.get(userId)?.has(scope) ?? false
}

/**
 * Open the long-lived stream the editor consumes. The server pushes
 * `toolRequest` events down it whenever an MCP browser tool is invoked for this
 * user; the editor runs the tool and POSTs the result to `/tool-result`.
 */
export function createEditorBridgeStream(
  userId: string,
  scope: EditorBridgeScope,
  signal: AbortSignal,
  // Test seam: the idle lease shrinks to milliseconds in unit tests.
  idleLeaseMs: number = STREAM_IDLE_LEASE_MS,
): ReadableStream<Uint8Array> {
  let closeStream: (() => void) | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const encoder = new TextEncoder()

      let bridgeId = ''
      let destroyBridge = (): void => {}
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let lease: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (lease) clearTimeout(lease)
        signal.removeEventListener('abort', cleanup)
        destroyBridge()

        // Only evict if we're still the current bridge for this scope. Keep
        // the user's other workspace registered until its own stream closes.
        const liveUserBridges = byUser.get(userId)
        if (liveUserBridges?.get(scope)?.bridgeId === bridgeId) {
          liveUserBridges.delete(scope)
          if (liveUserBridges.size === 0) byUser.delete(userId)
        }
        try {
          controller.close()
        } catch {
          /* already closed or cancelled */
        }
      }
      closeStream = cleanup

      const armLease = (): void => {
        if (closed) return
        if (lease) clearTimeout(lease)
        lease = setTimeout(cleanup, idleLeaseMs)
      }

      const emit = (event: AiStreamEvent): void => {
        if (closed) return
        try {
          controller.enqueue(encodeStreamEvent(event))
          // Tool traffic proves the stream is wanted — keep the idle lease
          // from expiring under an active batch. (The relay's own per-call
          // timeout is 90s, comfortably inside the lease.)
          armLease()
        } catch {
          cleanup()
        }
      }

      const created = createBridge(emit, signal)
      bridgeId = created.bridgeId
      destroyBridge = created.destroy

      // Newest instance of this workspace wins. The user's other workspace
      // remains connected, so Site and Content may serve MCP simultaneously.
      const userBridges = byUser.get(userId) ?? new Map<EditorBridgeScope, EditorBridgeEntry>()
      const previous = userBridges.get(scope)
      if (previous) previous.destroy()
      userBridges.set(scope, { bridgeId, bridge: created.bridge, destroy: destroyBridge })
      byUser.set(userId, userBridges)

      emit({ type: 'bridgeReady', bridgeId })

      // Heartbeat blank line keeps proxies from idling the connection;
      // `readNdjsonStream` skips empty lines.
      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode('\n'))
        } catch {
          cleanup()
        }
      }, 25_000)
      // Bound orphan lifetime when a proxy fails to propagate a closed
      // downstream connection. Idle-based: re-armed by every relayed tool
      // request, so only genuinely quiet streams recycle.
      armLease()

      if (signal.aborted) cleanup()
      else signal.addEventListener('abort', cleanup, { once: true })
    },
    cancel() {
      // Bun cancels the response body when the browser tab/context closes, but
      // that transport cancellation does not abort the server Request signal.
      // Tear down the heartbeat + registry entry from either lifecycle signal.
      closeStream?.()
      closeStream = null
    },
  })
}
