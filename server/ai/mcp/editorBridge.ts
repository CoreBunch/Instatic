/**
 * Live editor bridge for MCP.
 *
 * Browser-execution tools (insert HTML, apply CSS, set tokens, manage pages,
 * content CRUD, …) have no server implementation — their logic runs in the
 * editor app against the live store. To let an external MCP client use them,
 * the editor holds a long-lived NDJSON stream open while mounted; this module
 * keeps one bridge per user (the newest open editor wins) and lets the MCP
 * server relay a browser tool call to that editor and await its result.
 *
 * Reuses the chat bridge machinery wholesale: `createBridge` issues the
 * `AiBrowserBridge` (whose `callBrowser` resolves when the editor POSTs back to
 * the existing `/admin/api/ai/tool-result`), and `encodeStreamEvent` frames the
 * NDJSON the editor reads with `readNdjsonStream`.
 *
 * Security: the registry is keyed by `userId`, so an MCP connector can only
 * ever reach the open editor of its OWN owner.
 */
import type { AiBrowserBridge, AiStreamEvent } from '../runtime/types'
import { createBridge, encodeStreamEvent } from '../runtime'

interface EditorBridgeEntry {
  bridgeId: string
  bridge: AiBrowserBridge
  destroy: () => void
}

const byUser = new Map<string, EditorBridgeEntry>()

/** The live editor bridge for a user, or null when no editor is connected. */
export function getEditorBridgeForUser(userId: string): AiBrowserBridge | null {
  return byUser.get(userId)?.bridge ?? null
}

export function hasEditorBridge(userId: string): boolean {
  return byUser.has(userId)
}

/**
 * Open the long-lived stream the editor consumes. The server pushes
 * `toolRequest` events down it whenever an MCP browser tool is invoked for this
 * user; the editor runs the tool and POSTs the result to `/tool-result`.
 */
export function createEditorBridgeStream(userId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const encoder = new TextEncoder()

      const emit = (event: AiStreamEvent): void => {
        if (closed) return
        try {
          controller.enqueue(encodeStreamEvent(event))
        } catch {
          closed = true
        }
      }

      const { bridgeId, bridge, destroy } = createBridge(emit, signal)

      // Newest editor wins: tear down any previous bridge for this user so a
      // stale tab can't keep receiving tool requests.
      const previous = byUser.get(userId)
      if (previous) previous.destroy()
      byUser.set(userId, { bridgeId, bridge, destroy })

      emit({ type: 'bridgeReady', bridgeId })

      // Heartbeat blank line keeps proxies from idling the connection;
      // `readNdjsonStream` skips empty lines.
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode('\n'))
        } catch {
          closed = true
        }
      }, 25_000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        destroy()
        // Only evict if we're still the current bridge for this user.
        if (byUser.get(userId)?.bridgeId === bridgeId) byUser.delete(userId)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
      signal.addEventListener('abort', cleanup, { once: true })
    },
  })
}
