/**
 * Streaming transport + browser bridge registry for the AI runtime.
 *
 * Two responsibilities:
 *
 *   1. NDJSON encoding — `encodeStreamEvent(ev)` converts an AiStreamEvent
 *      into the wire bytes (`JSON.stringify(ev) + '\n'`).
 *
 *   2. Browser bridge registry — drivers need to await the browser's
 *      response to a write tool. `createBridge()` issues a fresh bridgeId
 *      and returns an `AiBrowserBridge` whose `callBrowser()` returns a
 *      promise that resolves when /admin/api/ai/tool-result POSTs back.
 *
 * Extracted into its own module so the chat handler stays focused on HTTP
 * + auth + persistence, not bridge bookkeeping.
 */

import { nanoid } from 'nanoid'
import type {
  AiBrowserBridge,
  AiStreamEvent,
  AiToolOutput,
} from './types'

// ---------------------------------------------------------------------------
// NDJSON encoder
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder()

export function encodeStreamEvent(event: AiStreamEvent): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(event) + '\n')
}

// ---------------------------------------------------------------------------
// Bridge registry
// ---------------------------------------------------------------------------

/**
 * How long a single browser tool call may stay pending before it is reclaimed.
 * Long enough for a slow-but-legitimate editor write to complete, short enough
 * that a dead/closed tab doesn't hang the SDK stream forever (ISS-030).
 */
const BROWSER_TOOL_TIMEOUT_MS = 90_000

interface PendingToolResolver {
  resolve(result: AiToolOutput): void
  reject(err: Error): void
  /** Clear the per-call timeout + abort listener. Idempotent. */
  cleanup(): void
}

interface BridgeEntry {
  pending: Map<string, PendingToolResolver>
  emit(event: AiStreamEvent): void
  /**
   * Called with the browser's post-mutation snapshot when a tool-result POST
   * carries one. Lets the turn refresh `toolContextBase.snapshot` so the NEXT
   * server-side read tool sees the state the just-executed browser tool
   * produced, instead of the stale turn-start snapshot.
   */
  onSnapshot?: (snapshot: unknown) => void
}

const activeBridges = new Map<string, BridgeEntry>()

/**
 * Allocate a new bridge for one chat stream. Returns the public-facing
 * bridgeId (sent to the browser via `bridgeReady`), an `AiBrowserBridge`
 * implementation drivers can call, and a `destroy()` hook the handler MUST
 * call in its finally-block (rejects any in-flight tool waiters).
 *
 * `emit` is the sink the driver-bridge uses to push `toolRequest` events
 * back through the NDJSON stream. Wire it to the same enqueue function the
 * chat handler uses for other events.
 */
export function createBridge(
  emit: (event: AiStreamEvent) => void,
  signal?: AbortSignal,
  timeoutMs: number = BROWSER_TOOL_TIMEOUT_MS,
  onSnapshot?: (snapshot: unknown) => void,
): {
  bridgeId: string
  bridge: AiBrowserBridge
  destroy: () => void
} {
  const bridgeId = nanoid()
  const entry: BridgeEntry = { pending: new Map(), emit, onSnapshot }
  activeBridges.set(bridgeId, entry)
  let destroyed = false

  const bridge: AiBrowserBridge = {
    callBrowser(toolName, input) {
      if (destroyed) {
        return Promise.reject(new Error('AI chat stream ended before tool result arrived.'))
      }
      const requestId = nanoid()
      return new Promise<AiToolOutput>((resolve, reject) => {
        // Settle (and remove) the pending wait on timeout or client disconnect
        // so a non-responding browser can never hang the SDK stream or leak the
        // bridge entry (ISS-030).
        const settle = (err: Error) => {
          const live = entry.pending.get(requestId)
          if (!live) return
          entry.pending.delete(requestId)
          live.cleanup()
          reject(err)
        }
        const timer = setTimeout(
          () => settle(new Error(`Browser tool "${toolName}" result timed out.`)),
          timeoutMs,
        )
        const onAbort = () => settle(new Error('AI chat stream aborted before tool result arrived.'))
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        }

        if (signal?.aborted) {
          clearTimeout(timer)
          reject(new Error('AI chat stream aborted before tool result arrived.'))
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        entry.pending.set(requestId, { resolve, reject, cleanup })
        emit({ type: 'toolRequest', requestId, toolName, input })
      })
    },
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    const live = activeBridges.get(bridgeId)
    if (!live) return
    if (live.pending.size > 0) {
      // Pending entries at stream-end mean the browser never POSTed a
      // tool-result for an in-flight tool call — diagnostic surface only,
      // not a fatal error.
      console.warn(
        `[ai/transport] bridge ${bridgeId} closed with ${live.pending.size} pending tool result(s).`,
      )
    }
    for (const pending of live.pending.values()) {
      pending.cleanup()
      pending.reject(new Error('AI chat stream ended before tool result arrived.'))
    }
    live.pending.clear()
    activeBridges.delete(bridgeId)
  }

  return { bridgeId, bridge, destroy }
}

/**
 * Resolve a pending tool wait. Called by the /admin/api/ai/tool-result
 * handler when the browser POSTs the result of a write tool.
 *
 * Returns true when a matching pending promise was found + resolved. False
 * when the bridge is gone (stream closed) or the requestId is unknown.
 */
export function resolveBridgeToolResult(
  bridgeId: string,
  requestId: string,
  result: AiToolOutput,
  snapshot?: unknown,
): boolean {
  const entry = activeBridges.get(bridgeId)
  if (!entry) return false
  const pending = entry.pending.get(requestId)
  if (!pending) return false
  entry.pending.delete(requestId)
  pending.cleanup()
  // Refresh the turn snapshot BEFORE resolving the waiter: the driver loop
  // resumes from `resolve()` and may run a server read tool next, which must
  // see post-mutation state. `undefined` means the browser sent no snapshot
  // (e.g. a read-only tool) — leave the existing one in place.
  if (snapshot !== undefined) entry.onSnapshot?.(snapshot)
  pending.resolve(result)
  return true
}

/**
 * Test-only: list every live bridge id. Production code uses
 * `resolveBridgeToolResult` + `createBridge` exclusively.
 */
export function __listActiveBridgesForTesting(): string[] {
  return [...activeBridges.keys()]
}

/**
 * Test-only: tear down every live bridge. Avoids cross-test bleed in unit
 * tests that exercise `createBridge` directly.
 */
export function __destroyAllBridgesForTesting(): void {
  for (const [, entry] of activeBridges) {
    for (const pending of entry.pending.values()) {
      pending.cleanup()
      pending.reject(new Error('Test teardown.'))
    }
    entry.pending.clear()
  }
  activeBridges.clear()
}
