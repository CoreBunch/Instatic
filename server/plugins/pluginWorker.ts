/**
 * Plugin worker entry — runs INSIDE a Bun `Worker` spawned by
 * `pluginWorkerHost`. The worker's job:
 *
 *   1. Read the plugin's bundled server entrypoint from disk.
 *   2. Spawn a QuickJS-WASM context (see `quickjsHost.ts`) that runs the
 *      bundle in a kernel-independent, capability-isolated sandbox. The
 *      plugin code has NO ambient access to Bun/Node APIs — its only
 *      way to interact with the host is the in-VM `__hostCall(target, args)`
 *      function, which routes through the existing api-call protocol.
 *   3. Bridge between the host (postMessage / api-reply) and the VM
 *      (PluginVm interface from quickjsHost.ts).
 *
 * The Bun.Worker keeps its previous responsibilities — crash isolation and
 * keeping plugin CPU off the host's main event loop. The trust boundary
 * has moved inward to QuickJS.
 *
 * Communication (unchanged):
 *   - Inbound:  `MainToWorkerMessage` from `self.onmessage`.
 *   - Outbound: `WorkerToMainMessage` via `self.postMessage`.
 *
 * Correlation IDs:
 *   - For requests originating in main (`load-plugin`, `run-lifecycle`,
 *     `run-route`, …) the worker echoes the same `correlationId` in
 *     its `*-result` reply.
 *   - For api-calls originating in the VM (storage / hooks / settings)
 *     the worker generates a fresh nanoid and waits for `api-reply`.
 */

import { nanoid } from 'nanoid'
import { readFile } from 'node:fs/promises'
import type {
  ApiCall,
  ApiReply,
  LoadPluginRequest,
  MainToWorkerMessage,
  RunHookFilterRequest,
  RunHookListenerRequest,
  RunLifecycleRequest,
  RunLoopFetchRequest,
  RunLoopPreviewRequest,
  RunMediaAdapterCallRequest,
  RunMediaUrlTransformerRequest,
  RunMigrateRequest,
  RunRouteRequest,
  RunScheduleRequest,
  SerializedResponse,
  UnloadPluginRequest,
  UpdateSettingsRequest,
  WorkerToMainMessage,
} from './protocol/messages'
import { createPluginVm, type PluginVm } from './quickjs/vm'
import { vmStackOf } from './quickjs/eval'
import { wrapEsmAsGlobal } from './quickjs/esmShim'

// ---------------------------------------------------------------------------
// Per-plugin in-worker registry — just the VM handle.
// ---------------------------------------------------------------------------

const vmsByPluginId = new Map<string, PluginVm>()

// ---------------------------------------------------------------------------
// Outbound message helpers
// ---------------------------------------------------------------------------

function send(msg: WorkerToMainMessage): void {
  ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)
}

/**
 * Pending `api-call`s awaiting `api-reply` from the host. Cleared on
 * resolve/reject so a misbehaving host (or worker shutdown) doesn't
 * leak handlers.
 */
const pendingApiCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: unknown) => void }
>()

function callHostApi(pluginId: string, target: ApiCall['target'], args: unknown[]): Promise<unknown> {
  const correlationId = nanoid()
  return new Promise<unknown>((resolve, reject) => {
    pendingApiCalls.set(correlationId, { resolve, reject })
    send({ kind: 'api-call', correlationId, pluginId, target, args })
  })
}

/**
 * Convert a caught VM error into the wire `{ error, stack }` pair. The
 * message is what API replies / HTTP error envelopes may surface; the
 * optional `stack` carries QuickJS-side frames (plugin sources eval with
 * the filename `plugin:<id>`) for host-side logging only.
 */
function errorFields(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) {
    const stack = vmStackOf(err)
    return stack !== undefined ? { error: err.message, stack } : { error: err.message }
  }
  return { error: String(err) }
}

function handleApiReply(reply: ApiReply): void {
  const pending = pendingApiCalls.get(reply.correlationId)
  if (!pending) return
  pendingApiCalls.delete(reply.correlationId)
  if (reply.ok) pending.resolve(reply.value)
  else pending.reject(new Error(reply.error ?? 'plugin api call failed'))
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

async function handleLoadPlugin(msg: LoadPluginRequest): Promise<void> {
  try {
    // Tear down any prior VM for the same plugin id (re-load on upgrade).
    const existing = vmsByPluginId.get(msg.pluginId)
    if (existing) {
      existing.dispose()
      vmsByPluginId.delete(msg.pluginId)
    }

    // The host passes an absolute path; we read the bundle as text and
    // hand it to the QuickJS bridge. The worker (not the VM) is what does
    // the file read — fs access stays outside the security boundary.
    const rawSource = await readFile(msg.entryFileUrl, 'utf-8')
    const pluginSource = wrapEsmAsGlobal(rawSource, '__plugin_exports')

    const vm = await createPluginVm({
      pluginSource,
      env: {
        pluginId: msg.pluginId,
        manifestVersion: msg.manifest.version,
        grantedPermissions: msg.manifest.grantedPermissions ?? [],
        // Default to a sensible derived path when the manifest hasn't yet been
        // written through `writePluginPackageFiles` (e.g. test fixtures that
        // assemble manifests by hand). The real install flow sets this.
        assetBasePath: msg.manifest.assetBasePath ?? `/uploads/plugins/${msg.pluginId}/${msg.manifest.version}`,
        settings: { ...msg.settings },
        hostCall: (target, args) =>
          callHostApi(msg.pluginId, target as ApiCall['target'], args),
        log: (args) => {
          send({ kind: 'log', pluginId: msg.pluginId, args })
        },
      },
    })

    vmsByPluginId.set(msg.pluginId, vm)
    send({
      kind: 'load-plugin-result',
      correlationId: msg.correlationId,
      ok: true,
      hooks: vm.exportedHooks as LoadPluginResultHooks,
    })
  } catch (err) {
    send({
      kind: 'load-plugin-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

type LoadPluginResultHooks = NonNullable<
  Extract<WorkerToMainMessage, { kind: 'load-plugin-result' }>['hooks']
>

function handleUnloadPlugin(msg: UnloadPluginRequest): void {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (vm) {
    vm.dispose()
    vmsByPluginId.delete(msg.pluginId)
  }
  send({ kind: 'unload-plugin-result', correlationId: msg.correlationId, ok: true })
}

/**
 * Settings push from the host — replaces the VM's `__plugin_settings`
 * mirror so subsequent `api.cms.settings.get(...)` calls resolve to the
 * new values synchronously. Sent after every persisted settings write
 * (admin PUT or the plugin's own `settings.replace`).
 */
async function handleUpdateSettings(msg: UpdateSettingsRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    // Plugin not loaded in this worker — nothing to refresh. Load-time
    // seeding from the host's settings cache covers the next load, so an
    // ok ack is the correct no-op.
    send({ kind: 'update-settings-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.updateSettings(msg.settings)
    send({ kind: 'update-settings-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'update-settings-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleRunLifecycle(msg: RunLifecycleRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  if (!vm.exportedHooks.includes(msg.hook)) {
    // No-op — the plugin didn't export this hook, identical to the
    // pre-QuickJS behavior of skipping when `module[hook]` was undefined.
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.runLifecycle(msg.hook)
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunMigrate(msg: RunMigrateRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  if (!vm.exportedHooks.includes('migrate')) {
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.runMigrate(msg.fromVersion)
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunRoute(msg: RunRouteRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({ kind: 'route-result', correlationId: msg.correlationId, ok: false, error: 'Plugin not loaded' })
    return
  }
  try {
    const result = await vm.runRoute(msg.routeKey, {
      request: msg.request,
      body: msg.body,
      user: msg.user,
    })
    const response = serializeRouteResult(result)
    send({ kind: 'route-result', correlationId: msg.correlationId, ok: true, response })
  } catch (err) {
    send({
      kind: 'route-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

/**
 * Convert a plugin-returned route result into the serialized response shape
 * the host expects. The VM returns plain JSON values (the bootstrap's
 * `__runRoute` JSON-stringifies the handler result), so we don't have an
 * actual `Response` to inspect here — the VM can't construct host
 * `Response` instances. Plugins that need custom status/headers/binary
 * bodies return `{ __response: true, status, headers, body }`; the
 * bootstrap pre-encodes the body (string → utf8, ArrayBuffer/TypedArray →
 * base64) and tags `bodyEncoding`, which we forward verbatim — the host's
 * `materializeRouteResponse` decodes it back into the real `Response` body.
 */
function serializeRouteResult(value: unknown): SerializedResponse {
  if (
    value &&
    typeof value === 'object' &&
    (value as { __response?: boolean }).__response === true
  ) {
    const r = value as {
      status?: number
      headers?: Record<string, string>
      body?: string
      bodyEncoding?: string
    }
    return {
      kind: 'response',
      status: typeof r.status === 'number' ? r.status : 200,
      headers: r.headers ?? {},
      body: typeof r.body === 'string' ? r.body : '',
      bodyEncoding: r.bodyEncoding === 'base64' ? 'base64' : 'utf8',
    }
  }
  return { kind: 'json', value: value === undefined ? { ok: true } : value }
}

async function handleRunHookListener(msg: RunHookListenerRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({ kind: 'hook-listener-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.runHookListener(msg.listenerId, msg.payload)
    send({ kind: 'hook-listener-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'hook-listener-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunHookFilter(msg: RunHookFilterRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({ kind: 'hook-filter-result', correlationId: msg.correlationId, ok: true, value: msg.value })
    return
  }
  try {
    const next = await vm.runHookFilter(msg.filterId, msg.value, msg.context)
    send({ kind: 'hook-filter-result', correlationId: msg.correlationId, ok: true, value: next })
  } catch (err) {
    send({
      kind: 'hook-filter-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunLoopFetch(msg: RunLoopFetchRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'loop-fetch-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  try {
    const value = await vm.runLoopFetch(msg.sourceId, msg.ctx)
    send({ kind: 'loop-fetch-result', correlationId: msg.correlationId, ok: true, value })
  } catch (err) {
    send({
      kind: 'loop-fetch-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunLoopPreview(msg: RunLoopPreviewRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'loop-preview-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  try {
    const value = await vm.runLoopPreview(msg.sourceId, msg.ctx)
    send({ kind: 'loop-preview-result', correlationId: msg.correlationId, ok: true, value })
  } catch (err) {
    send({
      kind: 'loop-preview-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunSchedule(msg: RunScheduleRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'schedule-result',
      correlationId: msg.correlationId,
      ok: false,
      status: 'error',
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
      durationMs: 0,
    })
    return
  }
  const startedAt = Date.now()
  try {
    await vm.runSchedule(msg.scheduleId, msg.maxDurationMs)
    send({
      kind: 'schedule-result',
      correlationId: msg.correlationId,
      ok: true,
      status: 'ok',
      durationMs: Date.now() - startedAt,
    })
  } catch (err) {
    const fields = errorFields(err)
    // The QuickJS interrupt handler raises `InternalError: interrupted`
    // when the per-eval deadline kicks in (see the deadline registry in
    // quickjs/eval.ts). Surface this as a distinct status so the admin UI
    // and consecutive-failures logic can treat timeouts separately from
    // logical errors.
    const status: 'timeout' | 'error' =
      fields.error.toLowerCase().includes('interrupted') ? 'timeout' : 'error'
    send({
      kind: 'schedule-result',
      correlationId: msg.correlationId,
      ok: false,
      status,
      ...fields,
      durationMs: Date.now() - startedAt,
    })
  }
}

async function handleRunMediaAdapterCall(msg: RunMediaAdapterCallRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'media-adapter-call-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  try {
    // Adapter methods take 0..2 arguments (most take exactly one). We pass
    // `args` as a wire-level unknown and let the VM bootstrap's
    // __runMediaAdapterCall destructure the first two positional values.
    const argsArray = Array.isArray(msg.args) ? msg.args : [msg.args]
    const value = await vm.runMediaAdapterCall(msg.adapterId, msg.method, argsArray)
    send({ kind: 'media-adapter-call-result', correlationId: msg.correlationId, ok: true, value })
  } catch (err) {
    send({
      kind: 'media-adapter-call-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

async function handleRunMediaUrlTransformer(msg: RunMediaUrlTransformerRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    // Transformer pipeline is purely additive — when the worker is gone,
    // pass the value through unchanged (null = "no rewrite").
    send({ kind: 'media-url-transformer-result', correlationId: msg.correlationId, ok: true, value: null })
    return
  }
  try {
    const payload = (msg.payload && typeof msg.payload === 'object'
      ? msg.payload
      : { path: '', ctx: null }) as { path: string; ctx: unknown }
    const value = await vm.runMediaUrlTransformer(msg.transformerId, payload)
    send({ kind: 'media-url-transformer-result', correlationId: msg.correlationId, ok: true, value })
  } catch (err) {
    send({
      kind: 'media-url-transformer-result',
      correlationId: msg.correlationId,
      ok: false,
      ...errorFields(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

;(self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage = (event: MessageEvent) => {
  const msg = event.data as MainToWorkerMessage
  switch (msg.kind) {
    case 'load-plugin':
      void handleLoadPlugin(msg)
      return
    case 'unload-plugin':
      handleUnloadPlugin(msg)
      return
    case 'update-settings':
      void handleUpdateSettings(msg)
      return
    case 'run-lifecycle':
      void handleRunLifecycle(msg)
      return
    case 'run-migrate':
      void handleRunMigrate(msg)
      return
    case 'run-route':
      void handleRunRoute(msg)
      return
    case 'run-hook-listener':
      void handleRunHookListener(msg)
      return
    case 'run-hook-filter':
      void handleRunHookFilter(msg)
      return
    case 'run-loop-fetch':
      void handleRunLoopFetch(msg)
      return
    case 'run-loop-preview':
      void handleRunLoopPreview(msg)
      return
    case 'run-schedule':
      void handleRunSchedule(msg)
      return
    case 'run-media-adapter-call':
      void handleRunMediaAdapterCall(msg)
      return
    case 'run-media-url-transformer':
      void handleRunMediaUrlTransformer(msg)
      return
    case 'api-reply':
      handleApiReply(msg)
      return
  }
}
