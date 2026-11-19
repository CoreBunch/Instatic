/**
 * Worker pool — per-plugin Bun.Worker lifecycle and bidirectional RPC.
 *
 * One Bun.Worker is spawned per plugin id (see `ensureWorkerFor`). This
 * gives true blast-radius isolation: an uncaught error in plugin A's
 * lifecycle / route handler / hook only kills plugin A's worker; sibling
 * plugins keep running. The next call to `loadPluginInWorker(A,...)` in
 * rpc.ts respawns A's worker.
 *
 * Correlation ids (nanoid strings) tie each outbound request message to its
 * inbound result. Shared worker state lives in `workerState.ts` so crash
 * recovery, API replies, and this transport layer do not import each other.
 */

import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol/messages'
import { parseApiCall } from '../protocol/parser'
import type { ValidatedApiCall } from '../protocol/apiCallSchema'
import { handleWorkerCrash } from './crashRecovery'
import { replyApiError } from './apiReplies'
import { pendingRequests, workers } from './workerState'

type ApiCallDispatcher = (msg: ValidatedApiCall) => Promise<void> | void

let apiCallDispatcher: ApiCallDispatcher | null = null

export function setApiCallDispatcher(dispatcher: ApiCallDispatcher): void {
  apiCallDispatcher = dispatcher
}

/**
 * Get the worker for a pluginId, spawning one if needed. Each spawn wires
 * its own message + error listeners so a crash in this worker only affects
 * pendings + state for THIS plugin id.
 */
function ensureWorkerFor(pluginId: string): Worker {
  const existing = workers.get(pluginId)
  if (existing) return existing
  const w = new Worker(new URL('../pluginWorker.ts', import.meta.url).href)
  workers.set(pluginId, w)
  w.addEventListener('message', (event: MessageEvent) => {
    handleWorkerMessage(pluginId, event.data)
  })
  w.addEventListener('error', (event: ErrorEvent) => {
    console.error(`[plugin:${pluginId}] uncaught error in worker:`, event.message, event.error)
    handleWorkerCrash(pluginId, event.message)
  })
  return w
}

function sendTo(pluginId: string, msg: MainToWorkerMessage): void {
  ensureWorkerFor(pluginId).postMessage(msg)
}

/**
 * Default budget for one host→worker RPC round-trip. Generous compared to
 * the VM's own 5 s eval deadline — its real job is to bound the damage of a
 * *wedged* worker (plugin code spinning past every in-VM guard), not to
 * race healthy calls.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000

export interface RequestFromWorkerOptions {
  /**
   * Wall-clock budget for the worker's reply. Schedule runs pass a budget
   * derived from their declared `maxDurationMs`; everything else
   * (load / lifecycle / route / hook / loop / media calls) uses the default.
   */
  timeoutMs?: number
}

export function requestFromWorker<TKind extends WorkerToMainMessage['kind']>(
  pluginId: string,
  msg: MainToWorkerMessage,
  expectedKind: TKind,
  options: RequestFromWorkerOptions = {},
): Promise<Extract<WorkerToMainMessage, { kind: TKind }>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  return new Promise<Extract<WorkerToMainMessage, { kind: TKind }>>((resolve, reject) => {
    // A wedged worker never crashes on its own, so without a deadline this
    // pending promise — and the HTTP request / publish render awaiting it —
    // would hang forever while crash recovery never engages. On expiry we
    // reject the call AND route the worker through the same teardown as a
    // crash: terminate it, reject its sibling pendings, unregister its
    // host-side state, record a crash event the admin UI surfaces, and let
    // the sliding-window counter decide respawn vs park.
    const timer = setTimeout(() => {
      if (!pendingRequests.has(msg.correlationId)) return
      pendingRequests.delete(msg.correlationId)
      const reason = `Plugin "${pluginId}" did not respond to ${msg.kind} within ${timeoutMs}ms`
      reject(new Error(reason))
      handleWorkerCrash(pluginId, reason)
    }, timeoutMs)
    pendingRequests.set(msg.correlationId, {
      pluginId,
      resolve: (value) => {
        clearTimeout(timer)
        const v = value as WorkerToMainMessage
        if (v.kind !== expectedKind) {
          reject(new Error(`Plugin worker returned unexpected message kind "${v.kind}"`))
          return
        }
        resolve(v as Extract<WorkerToMainMessage, { kind: TKind }>)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      },
    })
    sendTo(pluginId, msg)
  })
}

function workerMessageKind(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

function workerMessageCorrelationId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const correlationId = (value as { correlationId?: unknown }).correlationId
  return typeof correlationId === 'string' && correlationId ? correlationId : null
}

function workerLogArgs(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const args = (value as { args?: unknown }).args
  return Array.isArray(args) ? args : []
}

function rejectInvalidApiCall(workerPluginId: string, msg: unknown, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[plugin:${workerPluginId}] invalid api-call:`, err)

  const correlationId = workerMessageCorrelationId(msg)
  if (!correlationId) return
  replyApiError(workerPluginId, correlationId, message)
}

function dispatchValidatedApiCall(apiCall: ValidatedApiCall): void {
  if (!apiCallDispatcher) {
    replyApiError(
      apiCall.pluginId,
      apiCall.correlationId,
      'Plugin worker host API dispatcher is not configured',
    )
    return
  }

  try {
    const result = apiCallDispatcher(apiCall)
    void Promise.resolve(result).catch((err: unknown) => {
      replyApiError(apiCall.pluginId, apiCall.correlationId, err instanceof Error ? err.message : String(err))
    })
  } catch (err) {
    replyApiError(apiCall.pluginId, apiCall.correlationId, err instanceof Error ? err.message : String(err))
  }
}

function handleWorkerMessage(workerPluginId: string, msg: unknown): void {
  switch (workerMessageKind(msg)) {
    case 'log':
      // Defense-in-depth: a worker can't impersonate another plugin's id in
      // its log line. The log prefix is the worker's owning pluginId.
      console.info(`[plugin:${workerPluginId}]`, ...workerLogArgs(msg))
      return
    case 'api-call': {
      let apiCall: ValidatedApiCall
      try {
        apiCall = parseApiCall(msg)
      } catch (err) {
        rejectInvalidApiCall(workerPluginId, msg, err)
        return
      }
      // Defense-in-depth: an api-call must reference the worker's own
      // pluginId. Cross-plugin dispatch attempts get rejected before any
      // host-side side effect.
      if (apiCall.pluginId !== workerPluginId) {
        replyApiError(
          workerPluginId,
          apiCall.correlationId,
          `api-call from worker "${workerPluginId}" references foreign pluginId "${apiCall.pluginId}"`,
        )
        return
      }
      dispatchValidatedApiCall(apiCall)
      return
    }
    default: {
      const correlationId = workerMessageCorrelationId(msg)
      if (!correlationId) return
      const pending = pendingRequests.get(correlationId)
      if (!pending) return
      pendingRequests.delete(correlationId)
      pending.resolve(msg as WorkerToMainMessage)
    }
  }
}

/**
 * Fully tear down host-side state. Called by `activateInstalledServerPlugins`
 * before re-binding plugins (e.g. on server boot or after a settings change
 * that requires a clean re-load).
 */
export async function resetPluginWorker(): Promise<void> {
  for (const [, w] of workers) {
    try { w.terminate() } catch {/* noop */}
  }
  workers.clear()
  // Reject pending; respawn happens on next call.
  for (const [, pending] of pendingRequests) {
    pending.reject(new Error('Plugin worker reset'))
  }
  pendingRequests.clear()
}
