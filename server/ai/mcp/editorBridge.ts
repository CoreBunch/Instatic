/**
 * Live editor bridge for MCP.
 *
 * Browser-execution tools (insert HTML, apply CSS, set tokens, manage pages,
 * content CRUD, …) have no server implementation — their logic runs in the
 * editor app against the live store. To let an external MCP client use them,
 * the editor holds a long-lived newline-delimited JSON stream open while
 * mounted. Its HTTP response is advertised as an event stream so reverse
 * proxies preserve incremental delivery. This module keeps one bridge per user
 * and workspace (the first live instance owns it) and lets the MCP server relay a
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
import { MAIN_BRANCH_ID } from '@core/branches'
import type { AiBrowserBridge, AiStreamEvent } from '../runtime/types'
import { createBridge, encodeStreamEvent } from '../runtime'

interface EditorBridgeEntry {
  bridgeId: string
  bridge: AiBrowserBridge
  /** The branch the connected workspace has open; browser tools act in it. */
  branchId: string
  renew: () => void
}

export type EditorBridgeScope = 'site' | 'content'
/**
 * Bound orphan lifetime if a proxy fails to propagate disconnect. Halfway
 * through a quiet lease, ask the owning tab to renew it. An idle but live tab
 * keeps the same bridge even while another editor is waiting.
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

/** A reply can renew only the stream that requested it. */
export function renewEditorBridge(userId: string, scope: EditorBridgeScope, bridgeId: string): boolean {
  const owner = byUser.get(userId)?.get(scope)
  if (!owner || owner.bridgeId !== bridgeId) return false
  owner.renew()
  return true
}

/** The branch the user's live workspace has open, or null when disconnected. */
export function getEditorBridgeBranch(userId: string, scope: EditorBridgeScope): string | null {
  return byUser.get(userId)?.get(scope)?.branchId ?? null
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
  options: {
    /** The branch the workspace has open (its `X-Instatic-Branch`); main when absent. */
    branchId?: string
    /** Test seam: the idle lease shrinks to milliseconds in unit tests. */
    idleLeaseMs?: number
  } = {},
): ReadableStream<Uint8Array> | null {
  // ReadableStream.start runs synchronously, so checking and claiming the
  // slot is atomic across concurrent requests.
  if (hasEditorBridge(userId, scope)) return null
  const { branchId = MAIN_BRANCH_ID, idleLeaseMs = STREAM_IDLE_LEASE_MS } = options
  let closeStream: (() => void) | null = null

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const encoder = new TextEncoder()

      let bridgeId = ''
      let destroyBridge = (): void => {}
      let pendingCount = (): number => 0
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

      const enqueue = (chunk: Uint8Array): void => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch {
          cleanup()
        }
      }

      const armLease = (): void => {
        if (closed) return
        if (lease) clearTimeout(lease)
        lease = setTimeout(() => {
          if (pendingCount() > 0) {
            armLease()
            return
          }
          lease = setTimeout(cleanup, idleLeaseMs / 2)
          enqueue(encoder.encode('{"type":"bridgePing"}\n'))
        }, idleLeaseMs / 2)
      }

      const emit = (event: AiStreamEvent): void => {
        enqueue(encodeStreamEvent(event))
        armLease()
      }

      // Serial: the editor runs relayed tools strictly one at a time, so
      // pushing a whole batch at once only started every call's timeout (and
      // the idle lease) early — queued calls timed out, or the lease closed the
      // stream mid-batch, while the tab was still working through earlier ones.
      const created = createBridge(emit, signal, undefined, undefined, { serial: true })
      bridgeId = created.bridgeId
      destroyBridge = created.destroy
      pendingCount = created.pendingCount

      const userBridges = byUser.get(userId) ?? new Map<EditorBridgeScope, EditorBridgeEntry>()
      userBridges.set(scope, { bridgeId, bridge: created.bridge, branchId, renew: armLease })
      byUser.set(userId, userBridges)

      emit({ type: 'bridgeReady', bridgeId })

      // Heartbeat blank line keeps proxies from idling the connection;
      // `readNdjsonStream` skips empty lines.
      heartbeat = setInterval(() => enqueue(encoder.encode('\n')), 25_000)
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
