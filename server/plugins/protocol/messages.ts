/**
 * Worker IPC message types — all `MainToWorkerMessage` and `WorkerToMainMessage`
 * shapes plus their shared serialization helpers (SerializedRequest/Response/User).
 *
 * These types define the wire format between the host process and each
 * per-plugin Bun.Worker. The host and worker both import from here; keeping
 * the types in one file prevents skew between the two sides.
 */

import type { PluginManifest } from '@core/plugin-sdk'

// ---------------------------------------------------------------------------
// Shared serialization helpers
// ---------------------------------------------------------------------------

/** Serialized HTTP request — only the fields plugin route handlers can read. */
export interface SerializedRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Stringified body (typed to JSON-serializable text — large bodies aren't supported in v1). */
  body: string
}

/**
 * Serialized response from a plugin route handler. `value` is the
 * JSON-serializable return; if the plugin returned an actual `Response`
 * via `new Response(...)` the worker pre-extracts status/headers/body.
 */
export type SerializedResponse =
  | { kind: 'json'; value: unknown }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }

export interface SerializedUser {
  id: string
  email: string
  capabilities: string[]
}

// ---------------------------------------------------------------------------
// Main → Worker
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
  | LoadPluginRequest
  | UnloadPluginRequest
  | RunLifecycleRequest
  | RunMigrateRequest
  | RunRouteRequest
  | RunHookListenerRequest
  | RunHookFilterRequest
  | RunLoopFetchRequest
  | RunLoopPreviewRequest
  | RunScheduleRequest
  | RunMediaAdapterCallRequest
  | RunMediaUrlTransformerRequest
  | ApiReply

export interface LoadPluginRequest {
  kind: 'load-plugin'
  correlationId: string
  pluginId: string
  manifest: PluginManifest
  /** Absolute path to the plugin's server entrypoint module. */
  entryFileUrl: string
  /** Settings snapshot — populated into the worker's local cache so
   *  `settings.get` can resolve synchronously inside the plugin code. */
  settings: Record<string, string | number | boolean>
}

export interface UnloadPluginRequest {
  kind: 'unload-plugin'
  correlationId: string
  pluginId: string
}

export interface RunLifecycleRequest {
  kind: 'run-lifecycle'
  correlationId: string
  pluginId: string
  hook: 'install' | 'activate' | 'deactivate' | 'uninstall'
}

export interface RunMigrateRequest {
  kind: 'run-migrate'
  correlationId: string
  pluginId: string
  fromVersion: string
}

export interface RunRouteRequest {
  kind: 'run-route'
  correlationId: string
  pluginId: string
  routeKey: string
  request: SerializedRequest
  user: SerializedUser | null
  body: Record<string, unknown>
}

export interface RunHookListenerRequest {
  kind: 'run-hook-listener'
  correlationId: string
  pluginId: string
  listenerId: string
  event: string
  payload: unknown
}

export interface RunHookFilterRequest {
  kind: 'run-hook-filter'
  correlationId: string
  pluginId: string
  filterId: string
  name: string
  value: unknown
  /**
   * Extra context fields forwarded from `hookBus.applyFilter`. Plugin
   * handlers receive these merged into `{ pluginId, ...context }`.
   * For `publish.html` / `publish.headers` this carries
   * `{ siteId, pageId, slug }`.
   */
  context?: Record<string, unknown>
}

export interface RunLoopFetchRequest {
  kind: 'run-loop-fetch'
  correlationId: string
  pluginId: string
  sourceId: string
  ctx: unknown
}

export interface RunLoopPreviewRequest {
  kind: 'run-loop-preview'
  correlationId: string
  pluginId: string
  sourceId: string
  ctx: unknown
}

/**
 * Fire a scheduled job inside the plugin's worker. Sent by the host
 * `scheduler.ts` tick when a schedule's `next_run_at` has passed and the
 * row has been claimed via the HA lock. The worker invokes the stored
 * handler inside the QuickJS sandbox and replies with a `schedule-result`
 * carrying the status + measured duration.
 */
export interface RunScheduleRequest {
  kind: 'run-schedule'
  correlationId: string
  pluginId: string
  scheduleId: string
  /** Wall-clock budget for this fire. Overrides the VM's default 5s deadline. */
  maxDurationMs: number
}

/**
 * Methods on a `MediaStorageAdapter` the host can invoke. Mirrors the
 * adapter contract in `src/core/plugin-sdk/types.ts` exactly. One generic
 * runner is used (vs. one runner per method) because every adapter
 * exposes the same set of named callbacks; routing in the VM is just a
 * property lookup on the handler object.
 */
export type MediaAdapterMethod =
  | 'beginWrite'
  | 'finalizeWrite'
  | 'abortWrite'
  | 'delete'
  | 'getReadUrl'
  | 'verify'

/**
 * Invoke a method on a plugin-registered media storage adapter. The host
 * builds these in `mediaStorageRegistry`-wrapping adapter shims that the
 * upload pipeline calls; the shim turns each call into one of these
 * requests and awaits the matching `media-adapter-call-result`.
 *
 * `args` is the JSON-serializable input passed to the method. Bytes are
 * NEVER part of `args` — the adapter signs upload plans; the host
 * streams bytes directly via `executeUploadPlan` outside the sandbox.
 */
export interface RunMediaAdapterCallRequest {
  kind: 'run-media-adapter-call'
  correlationId: string
  pluginId: string
  adapterId: string
  method: MediaAdapterMethod
  args: unknown
}

/**
 * Invoke a registered URL transformer. The transformer takes a media path
 * and a context, returns either a rewritten path or `null` (which the
 * caller treats as pass-through). Multiple transformers chain in
 * registration order — the host chains them via `hookBus.filter` so the
 * same pipeline as the rest of the CMS handles chaining + error fallback.
 */
export interface RunMediaUrlTransformerRequest {
  kind: 'run-media-url-transformer'
  correlationId: string
  pluginId: string
  transformerId: string
  /** Single { path, ctx } payload — kept opaque here so the schema lives in one place. */
  payload: unknown
}

/** Host's reply to a worker-initiated `api-call`. */
export interface ApiReply {
  kind: 'api-reply'
  correlationId: string
  ok: boolean
  value?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// Worker → Main
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
  | LoadPluginResult
  | UnloadPluginResult
  | LifecycleResult
  | RouteResult
  | HookListenerResult
  | HookFilterResult
  | LoopFetchResultMessage
  | LoopPreviewResult
  | ScheduleResult
  | MediaAdapterCallResult
  | MediaUrlTransformerResult
  | ApiCall
  | WorkerLogEvent

export interface LoadPluginResult {
  kind: 'load-plugin-result'
  correlationId: string
  ok: boolean
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
  /**
   * List of hook names the plugin module exports. Lets the host skip the
   * round-trip when calling a non-existent lifecycle hook.
   */
  hooks?: Array<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>
}

export interface UnloadPluginResult {
  kind: 'unload-plugin-result'
  correlationId: string
  ok: boolean
}

export interface LifecycleResult {
  kind: 'lifecycle-result'
  correlationId: string
  ok: boolean
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

export interface RouteResult {
  kind: 'route-result'
  correlationId: string
  ok: boolean
  response?: SerializedResponse
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

export interface HookListenerResult {
  kind: 'hook-listener-result'
  correlationId: string
  ok: boolean
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

export interface HookFilterResult {
  kind: 'hook-filter-result'
  correlationId: string
  ok: boolean
  /** Plugin-transformed value (when ok). */
  value?: unknown
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

export interface LoopFetchResultMessage {
  kind: 'loop-fetch-result'
  correlationId: string
  ok: boolean
  /** `{ items, totalItems }` shape from the plugin's source — re-validated host-side. */
  value?: { items: unknown[]; totalItems: number }
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

export interface LoopPreviewResult {
  kind: 'loop-preview-result'
  correlationId: string
  ok: boolean
  value?: unknown[]
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

/**
 * Outcome of a scheduled fire. `durationMs` is measured inside the worker
 * (start of handler call to handler return / throw) so the host's
 * recorded latency reflects the plugin's actual work, not transport
 * overhead. `status='timeout'` is set when the VM aborted via its
 * deadline interrupt — the error message will reflect that.
 */
export interface ScheduleResult {
  kind: 'schedule-result'
  correlationId: string
  ok: boolean
  /** 'ok' on success, 'error' on a throw, 'timeout' when the deadline aborted. */
  status: 'ok' | 'error' | 'timeout'
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
  durationMs: number
}

export interface MediaAdapterCallResult {
  kind: 'media-adapter-call-result'
  correlationId: string
  ok: boolean
  value?: unknown
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

export interface MediaUrlTransformerResult {
  kind: 'media-url-transformer-result'
  correlationId: string
  ok: boolean
  /** Plugin-transformed path. When `null`, the caller falls back to the
   *  previous value (chain pass-through). */
  value?: string | null
  error?: string
  /**
   * QuickJS-side stack frames of the failure (plugin sources are evaluated
   * with the filename `plugin:<id>`). For host-side `[plugin:<id>]` logging
   * only — never sent to HTTP clients.
   */
  stack?: string
}

/**
 * Worker-initiated call into the host's ServerPluginApi. Awaiting an
 * `ApiReply` with the same correlationId.
 *
 * `target` is a dotted path like `cms.storage.list`, `cms.hooks.emit`,
 * `cms.routes.register`, `cms.settings.replace`, `cms.loops.registerSource`,
 * `cms.hooks.on`, `cms.hooks.filter`. The host validates each target
 * against an allowlist before dispatch.
 */
export interface ApiCall {
  kind: 'api-call'
  correlationId: string
  pluginId: string
  target: string
  args: unknown[]
}

/**
 * Plugin `api.plugin.log(...)` — fire-and-forget, no correlation id.
 * Host prints with `[plugin:<id>]` prefix.
 */
export interface WorkerLogEvent {
  kind: 'log'
  pluginId: string
  args: unknown[]
}
