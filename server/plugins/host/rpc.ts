/**
 * Plugin worker RPC — high-level operations that cross the main↔worker
 * boundary (load, unload, lifecycle, route, schedule, etc.).
 *
 * Each function maps to one `kind` message pair in the worker protocol.
 * Internal helpers (runHookListenerInWorker, runLoopFetchInWorker, etc.) are
 * not exported — they're invoked only through api-call dispatch callbacks
 * registered in apiDispatch.ts.
 */

import { nanoid } from 'nanoid'
import type { ServerPluginLifecycleHook, PluginManifest } from '@core/plugin-sdk'
import { loopSourceRegistry } from '@core/loops/registry'
import { hookBus } from '@core/plugins/hookBus'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
import type { LoopFetchResult, LoopItem } from '@core/loops/types'
import type { SerializedRequest, SerializedResponse, SerializedUser } from '../protocol/messages'
import type { LoadPluginResult } from '../protocol/messages'
import { normalizeRoutePath } from '../protocol/parser'
import { hostPlugins } from './registry'
import { requestFromWorker } from './workerPool'
import { describeWorkerError, workerCallError } from './workerErrors'
import { workers } from './workerState'
import type { HostRouteAccess } from './types'

/**
 * Transport + teardown slack added on top of a schedule's own VM budget for
 * the worker RPC timeout. The RPC timeout must outlive the in-VM
 * `maxDurationMs` deadline so the normal overrun failure mode is a clean
 * `status: 'timeout'` result from the worker — the host-side reset only
 * engages when the worker is truly wedged.
 */
const SCHEDULE_RPC_SLACK_MS = 10_000

export async function loadPluginInWorker(args: {
  manifest: PluginManifest
  entryFileUrl: string
  settings: Record<string, string | number | boolean>
}): Promise<LoadPluginResult> {
  // Clear any prior host-side state for this plugin id — hook listeners,
  // loop sources, route entries — so a re-load (e.g. install → activate
  // sequence, or upgrade install) starts from a clean slate. The worker
  // also replaces its in-worker entry on `load-plugin`, so we don't need
  // to send an explicit `unload-plugin` first.
  const prior = hostPlugins.get(args.manifest.id)
  if (prior) {
    for (const source of prior.loopSources) {
      loopSourceRegistry.unregister(source.sourceId)
    }
    hookBus.unregisterPlugin(args.manifest.id)
    mediaStorageRegistry.unregisterPlugin(args.manifest.id)
    mediaVariantDelegateRegistry.unregisterPlugin(args.manifest.id)
  }
  hostPlugins.set(args.manifest.id, {
    manifest: args.manifest,
    routes: new Map(),
    hookListeners: [],
    hookFilters: [],
    loopSources: [],
    mediaAdapters: [],
    mediaUrlTransformers: [],
    inflightFetches: new Map(),
  })

  const correlationId = nanoid()
  const result = await requestFromWorker(
    args.manifest.id,
    {
      kind: 'load-plugin',
      correlationId,
      pluginId: args.manifest.id,
      manifest: args.manifest,
      entryFileUrl: args.entryFileUrl,
      settings: args.settings,
    },
    'load-plugin-result',
  )
  return result
}

export async function unloadPluginInWorker(pluginId: string): Promise<void> {
  // Tear down host-side registrations BEFORE the worker forgets the plugin
  // — once the worker is told to drop, any in-flight callbacks would have
  // nowhere to go. The route map itself is owned by `hostPlugins`; clearing
  // the entry below also clears the routes.
  const entry = hostPlugins.get(pluginId)
  if (entry) {
    for (const source of entry.loopSources) {
      loopSourceRegistry.unregister(source.sourceId)
    }
    // Mirror the crash path: abort any in-flight outbound fetches before
    // tearing down the host record, so naked sockets don't outlive the
    // plugin record they belonged to.
    for (const ctrl of entry.inflightFetches.values()) {
      try { ctrl.abort(new Error(`Plugin "${pluginId}" unloaded`)) } catch { /* ignore */ }
    }
    entry.inflightFetches.clear()
    hookBus.unregisterPlugin(pluginId)
    mediaStorageRegistry.unregisterPlugin(pluginId)
    mediaVariantDelegateRegistry.unregisterPlugin(pluginId)
  }
  hostPlugins.delete(pluginId)

  const w = workers.get(pluginId)
  if (!w) return
  // Send `unload-plugin` so the worker can do any cleanup, then terminate
  // the worker entirely. Per-plugin worker → terminate fully on unload so
  // we don't keep a dead worker process around.
  try {
    await requestFromWorker(
      pluginId,
      { kind: 'unload-plugin', correlationId: nanoid(), pluginId },
      'unload-plugin-result',
    )
  } catch {
    // worker may have already crashed — terminate is still safe
  }
  try { w.terminate() } catch {/* may already be terminated */}
  workers.delete(pluginId)
}

export async function runLifecycleInWorker(
  pluginId: string,
  hook: Exclude<ServerPluginLifecycleHook, 'migrate'>,
): Promise<void> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-lifecycle', correlationId: nanoid(), pluginId, hook },
    'lifecycle-result',
  )
  if (!result.ok) {
    throw workerCallError(result.error ?? `Plugin "${pluginId}" ${hook} failed`, result.stack)
  }
}

export async function runMigrateInWorker(
  pluginId: string,
  fromVersion: string,
): Promise<void> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-migrate', correlationId: nanoid(), pluginId, fromVersion },
    'lifecycle-result',
  )
  if (!result.ok) {
    throw workerCallError(result.error ?? `Plugin "${pluginId}" migrate failed`, result.stack)
  }
}

/**
 * Forward an inbound HTTP request to the plugin's route handler in the
 * worker. The host has already verified the route is registered + the
 * caller has the required capability — this function only handles the
 * worker round-trip and response materialisation.
 */
export async function runRouteInWorker(args: {
  pluginId: string
  method: string
  path: string
  request: Request
  user: SerializedUser | null
}): Promise<Response> {
  const entry = hostPlugins.get(args.pluginId)
  const routeKey = `${args.method.toUpperCase()}:${normalizeRoutePath(args.path)}`
  const route = entry?.routes.get(routeKey)
  if (!route) return new Response('Plugin route not found', { status: 404 })

  // Real Bun `Headers` supports both `forEach` and the entries iterator.
  // Test stubs may only provide `.get(name)` — handle both shapes so we
  // can ship realistic typing without forcing tests to mock the full
  // Headers contract.
  const headers: Record<string, string> = {}
  const reqHeaders = args.request.headers as unknown as
    | { forEach?: (cb: (value: string, key: string) => void) => void; entries?: () => Iterable<[string, string]> }
    | null
  if (reqHeaders && typeof reqHeaders.forEach === 'function') {
    reqHeaders.forEach((v: string, k: string) => { headers[k.toLowerCase()] = v })
  } else if (reqHeaders && typeof reqHeaders.entries === 'function') {
    for (const [k, v] of reqHeaders.entries()) headers[k.toLowerCase()] = v
  }

  // Read the body once, pre-parse it for the handler context. Content-Type
  // drives the parser: JSON for `application/json`, URLSearchParams for
  // `application/x-www-form-urlencoded` (standard HTML form POSTs),
  // FormData-as-record for `multipart/form-data` (text fields only — file
  // uploads stay opaque and require explicit handling). Anything else
  // leaves `parsedBody` empty; the handler can read the raw text via
  // `ctx.req.text()`.
  //
  // Form-encoded support is essential — any plugin that exposes a public
  // POST endpoint consumed by an HTML `<form>` (Forms Builder, Newsletter
  // subscribe, etc.) submits with this Content-Type by default. Without
  // parsing it, every such plugin returns 400 because the expected fields
  // are missing.
  const bodyText = args.method !== 'GET' ? await args.request.text() : ''
  let parsedBody: Record<string, unknown> = {}
  if (bodyText) {
    const contentType = (headers['content-type'] ?? '').toLowerCase()
    if (contentType.startsWith('application/json')) {
      try {
        const parsed: unknown = JSON.parse(bodyText)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedBody = parsed as Record<string, unknown>
        }
      } catch {
        // malformed JSON — handler can inspect raw text
      }
    } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
      // URLSearchParams collapses repeated keys to the last value; for
      // forms with `name="tags"` repeated (multi-select / checkbox-group)
      // we promote those to arrays. Single-value fields stay as strings.
      const params = new URLSearchParams(bodyText)
      const grouped = new Map<string, string[]>()
      for (const [key, value] of params) {
        const list = grouped.get(key)
        if (list) list.push(value)
        else grouped.set(key, [value])
      }
      for (const [key, values] of grouped) {
        parsedBody[key] = values.length === 1 ? values[0]! : values
      }
    } else if (contentType.startsWith('multipart/form-data')) {
      // Bun's `Request.formData()` parses multipart. We re-create a
      // Request from the captured bodyText + content-type so file fields
      // become `File` instances and text fields become strings. File
      // payloads stay as `File` objects — the plugin handler can decide
      // whether to read them via `.arrayBuffer()` or reject.
      try {
        const fakeReq = new Request('about:blank', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: bodyText,
        })
        const form = await fakeReq.formData()
        const grouped = new Map<string, FormDataEntryValue[]>()
        for (const [key, value] of form.entries()) {
          const list = grouped.get(key)
          if (list) list.push(value)
          else grouped.set(key, [value])
        }
        for (const [key, values] of grouped) {
          parsedBody[key] = values.length === 1 ? values[0]! : values
        }
      } catch {
        // malformed multipart — handler can inspect raw text
      }
    }
  }

  const serializedReq: SerializedRequest = {
    url: args.request.url,
    method: args.request.method,
    headers,
    body: bodyText,
  }

  const result = await requestFromWorker(
    args.pluginId,
    {
      kind: 'run-route',
      correlationId: nanoid(),
      pluginId: args.pluginId,
      routeKey,
      request: serializedReq,
      user: args.user,
      body: parsedBody,
    },
    'route-result',
  )
  if (!result.ok || !result.response) {
    // VM stacks stay in the server log — the HTTP body carries only the message.
    console.error(
      `[plugin:${args.pluginId}] route "${routeKey}" handler failed:`,
      describeWorkerError(result.error, result.stack, 'Plugin route failed'),
    )
    return Response.json({ error: result.error ?? 'Plugin route failed' }, { status: 500 })
  }
  return materializeResponse(result.response)
}

function materializeResponse(response: SerializedResponse): Response {
  if (response.kind === 'response') {
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    })
  }
  return Response.json(response.value)
}

function getRegisteredRoute(
  pluginId: string,
  method: string,
  path: string,
): { access: HostRouteAccess } | null {
  const entry = hostPlugins.get(pluginId)
  const route = entry?.routes.get(`${method.toUpperCase()}:${normalizeRoutePath(path)}`)
  return route ? { access: route.access } : null
}

/**
 * Lookup helper used by the plugin-runtime forwarder — given a plugin id
 * and request method/path, return the route's access policy (capability /
 * authenticated / public). Replaces the previous
 * `findPluginRouteCapability` which returned `{ capability: string | null }`
 * and was ambiguous about whether `null` meant authenticated or public.
 */
export function findPluginRouteAccess(
  pluginId: string,
  method: string,
  path: string,
): { access: HostRouteAccess } | null {
  return getRegisteredRoute(pluginId, method, path)
}

/**
 * Fire a registered schedule handler in the plugin's worker. Returns the
 * status + measured duration. The scheduler tick records the outcome to
 * `plugin_schedules` + `plugin_schedule_runs`. If the worker isn't running
 * or has been terminated, the call rejects with the underlying error;
 * the scheduler converts that into a 'error' status row.
 */
export async function runScheduleInWorker(args: {
  pluginId: string
  scheduleId: string
  maxDurationMs: number
}): Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string; durationMs: number }> {
  const result = await requestFromWorker(
    args.pluginId,
    {
      kind: 'run-schedule',
      correlationId: nanoid(),
      pluginId: args.pluginId,
      scheduleId: args.scheduleId,
      maxDurationMs: args.maxDurationMs,
    },
    'schedule-result',
    // The RPC budget must outlive the in-VM deadline (see SCHEDULE_RPC_SLACK_MS).
    { timeoutMs: args.maxDurationMs + SCHEDULE_RPC_SLACK_MS },
  )
  if (!result.ok && result.stack) {
    // The run row stores only the message; the VM stack goes to the server log.
    console.error(
      `[plugin:${args.pluginId}] schedule "${args.scheduleId}" failed:`,
      describeWorkerError(result.error, result.stack, 'schedule run failed'),
    )
  }
  return {
    status: result.status,
    error: result.error,
    durationMs: result.durationMs,
  }
}

// ---------------------------------------------------------------------------
// Internal worker RPC helpers — called from handler files under handlers/
// ---------------------------------------------------------------------------

export async function runHookListenerInWorker(
  pluginId: string,
  listenerId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-hook-listener', correlationId: nanoid(), pluginId, listenerId, event, payload },
    'hook-listener-result',
  )
  if (!result.ok) {
    console.error(
      `[plugin:${pluginId}] hook listener for "${event}" threw:`,
      describeWorkerError(result.error, result.stack, 'unknown error'),
    )
  }
}

export async function runHookFilterInWorker(
  pluginId: string,
  filterId: string,
  name: string,
  value: unknown,
  context?: Record<string, unknown>,
): Promise<unknown> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-hook-filter', correlationId: nanoid(), pluginId, filterId, name, value, context },
    'hook-filter-result',
  )
  if (!result.ok) {
    console.error(
      `[plugin:${pluginId}] hook filter "${name}" threw:`,
      describeWorkerError(result.error, result.stack, 'unknown error'),
    )
    return value
  }
  return result.value
}

export async function runLoopFetchInWorker(
  pluginId: string,
  sourceId: string,
  ctx: unknown,
): Promise<LoopFetchResult> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-loop-fetch', correlationId: nanoid(), pluginId, sourceId, ctx },
    'loop-fetch-result',
  )
  if (!result.ok || !result.value) {
    console.error(
      `[plugin:${pluginId}] loop source "${sourceId}" fetch failed:`,
      describeWorkerError(result.error, result.stack, 'unknown error'),
    )
    return { items: [], totalItems: 0 }
  }
  // Cast: items shape is unknown over the wire; the publisher revalidates.
  // LoopItem is a structural { id: string, ... } shape.
  return {
    items: result.value.items as LoopItem[],
    totalItems: result.value.totalItems,
  }
}
