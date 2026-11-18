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
import { dispatchCoolOffRemainingMs, PluginDispatchCoolingOffError, recordDispatchOverrun } from './dispatchCoolOff'
import { notePluginOutputDisruption } from './outputWatch'
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
  // A worker the host has already replaced may still have events queued (a
  // second overrun report, a late error). They belong to a VM that is gone
  // and must not touch the plugin's new worker.
  const isCurrent = (): boolean => workers.get(pluginId) === w
  w.addEventListener('message', (event: MessageEvent) => {
    if (isCurrent()) handleWorkerMessage(pluginId, event.data)
  })
  w.addEventListener('error', (event: ErrorEvent) => {
    if (!isCurrent()) return
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
 * the VM's own limits (5 s of execution, a 20 s wall-clock call budget —
 * `quickjs/limits.ts`): a slow handler fails alone on those. This one's real
 * job is to bound the damage of a *wedged* worker (plugin code spinning past
 * every in-VM guard), not to race healthy calls.
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
  // A dispatch that keeps overrunning is not sent while it cools off. Its
  // output is then missing from whatever is being rendered, which must not
  // be cached or baked (`outputWatch.ts`).
  const dispatch = dispatchKeyOf(msg)
  if (dispatch) {
    const coolOffMs = dispatchCoolOffRemainingMs(pluginId, dispatch.key)
    if (coolOffMs > 0) {
      notePluginOutputDisruption()
      return Promise.reject(new PluginDispatchCoolingOffError(pluginId, dispatch.key, coolOffMs))
    }
    rememberDispatchKey(pluginId, dispatch)
  }
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

/**
 * The cool-off key of a dispatch a visitor's request can cause, and the name
 * the VM will report it under if it overruns (`CallDispatch`). The key must
 * survive a restart, so a hook is keyed by its event or filter name, not by
 * its registration id. Lifecycle, settings and schedule calls have no key.
 */
function dispatchKeyOf(msg: MainToWorkerMessage): { key: string; kind: string; vmName: string } | null {
  switch (msg.kind) {
    case 'run-route':
      return { key: `route ${msg.routeKey}`, kind: 'route', vmName: msg.routeKey }
    case 'run-hook-listener':
      return { key: `listener ${msg.event}`, kind: 'hook', vmName: msg.listenerId }
    case 'run-hook-filter':
      return { key: `filter ${msg.name}`, kind: 'hook', vmName: msg.filterId }
    case 'run-loop-fetch':
      return { key: `loop ${msg.sourceId}`, kind: 'loop', vmName: msg.sourceId }
    case 'run-loop-preview':
      return { key: `loop ${msg.sourceId}`, kind: 'loop', vmName: msg.sourceId }
    case 'run-media-adapter-call':
      return { key: `media ${msg.adapterId}`, kind: 'media', vmName: msg.adapterId }
    case 'run-media-url-transformer':
      return { key: 'media-url', kind: 'media', vmName: msg.transformerId }
    default:
      return null
  }
}

/** Cool-off keys of dispatches sent to each worker, by what the VM calls them. */
const sentDispatchKeys = new Map<string, Map<string, string>>()

function rememberDispatchKey(pluginId: string, dispatch: { key: string; kind: string; vmName: string }): void {
  let sent = sentDispatchKeys.get(pluginId)
  if (!sent) {
    sent = new Map()
    sentDispatchKeys.set(pluginId, sent)
  }
  sent.set(`${dispatch.kind}\n${dispatch.vmName}`, dispatch.key)
}

const OVERRUN_DISPATCH_KINDS = new Set(['lifecycle', 'route', 'hook', 'loop', 'schedule', 'settings', 'media'])

/**
 * A call ran out of its wall-clock budget. Its own failure result was posted
 * first and is already resolved. Stop the worker so the abandoned handler
 * cannot resume and act; calls still in flight are rejected as retriable.
 *
 * What happens next depends on which call it was:
 *   - a lifecycle call: the plugin cannot start, which is a crash, with the
 *     crash counter's parking;
 *   - a dispatch a request can cause (route, hook, loop, media): its
 *     cool-off streak grows (`dispatchCoolOff.ts`);
 *   - anything else (a schedule, a settings push): restart only.
 * The reason names the call (never request data); it is what the admin's
 * crash events and the server log show.
 */
function handleCallOverrun(workerPluginId: string, msg: unknown): void {
  const { reason, dispatch } = msg as { reason?: unknown; dispatch?: { kind?: unknown; name?: unknown } }
  const kind = typeof dispatch?.kind === 'string' && OVERRUN_DISPATCH_KINDS.has(dispatch.kind) ? dispatch.kind : 'call'
  const name = typeof dispatch?.name === 'string' && dispatch.name.length <= 200 ? dispatch.name : ''
  const detail = typeof reason === 'string' && reason ? reason : 'Plugin call exceeded its time budget'
  // Only a key this host sent is trusted to name a cool-off.
  const key = sentDispatchKeys.get(workerPluginId)?.get(`${kind}\n${name}`)
  sentDispatchKeys.delete(workerPluginId)
  const what = key ?? (name ? `${kind} "${name}"` : kind)

  if (kind === 'lifecycle') {
    handleWorkerCrash(workerPluginId, `${what} did not finish: ${detail}`)
    return
  }
  let coolOff = ''
  if (key) {
    const coolOffMs = recordDispatchOverrun(workerPluginId, key)
    if (coolOffMs > 0) coolOff = ` It is held back for ${coolOffMs / 1000}s.`
  }
  handleWorkerCrash(workerPluginId, `${what} ran out of time: ${detail}.${coolOff}`, 'overrun')
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
    case 'call-overrun':
      handleCallOverrun(workerPluginId, msg)
      return
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
