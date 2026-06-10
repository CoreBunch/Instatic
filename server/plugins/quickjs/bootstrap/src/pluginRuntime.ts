/**
 * Full-plugin VM runtime — the entrypoint. Wires the global `__plugin_handlers`
 * registry and installs every `__run*` dispatcher the host invokes to drive
 * plugin code (`__runLifecycle` / `__runRoute` / `__runHookListener` /
 * `__runHookFilter` / `__runLoopFetch` / `__runLoopPreview` / `__runSchedule` /
 * `__runMediaAdapterCall` / `__runMediaUrlTransformer` / `__updateSettings` /
 * `__detectExportedHooks`). The `api` object plugins receive is built by the
 * `__buildApi()` factory in `./buildApi` (imported for its `globalThis`
 * side-effect; the runners reach it via the installed global).
 *
 * This is the typed authoring surface for what used to be the
 * `API_AND_RUNNERS_SOURCE` template-literal blob. It is bundled to a single
 * IIFE string by `scripts/sync-plugin-bootstrap.ts` (see the committed
 * artifact in `../generated/pluginBootstrap.ts`) and evaluated inside every
 * plugin QuickJS VM before any plugin code runs. The host-injected globals and
 * the entry points installed here are declared in `globals.d.ts`.
 */

import './buildApi'
import { fromJson, toJson } from './boundary'

// ------- handler registries (live inside the VM, host has metadata) -------
globalThis.__plugin_handlers = {
  routes: {},
  listeners: {},
  filters: {},
  loopSources: {},
  schedules: {},
  // Media subsystem — each adapter is keyed by its namespaced id; each
  // entry is the { beginWrite, finalizeWrite, abortWrite, delete,
  // getReadUrl?, verify, readStream? } record the plugin handed to
  // api.cms.media.registerStorageAdapter. URL transformers are keyed by
  // a host-minted transformer id (mirroring the hook-filter pattern).
  mediaAdapters: {},
  mediaUrlTransformers: {},
}

// ------- runners — host calls these to dispatch into plugin code -------

/**
 * Resolve the actual plugin module from __plugin_exports. Plugin authors
 * write one of two shapes:
 *   - named lifecycle exports: `export function activate(api) { ... }`
 *   - a default-export module: `export default { install, activate, ... }`
 *
 * Both code paths land on __plugin_exports — but with named exports the
 * hooks are direct properties, while with default-export the hooks live
 * one level deeper (under .default). We unwrap the latter so the runners
 * find the hooks either way. The SDK build's facade ALSO unwraps, but
 * keeping this here as belt-and-suspenders means raw-ESM single-file
 * plugins (test fixtures, hand-authored modules going through the
 * worker's `ensureIifeForm` shim) work too.
 */
function __resolvePluginModule(): Record<string, unknown> | null {
  const root = globalThis.__plugin_exports
  if (!root || typeof root !== 'object') return null
  const def = root.default
  const isPluginModule = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== 'object') return false
    const m = v as Record<string, unknown>
    return (
      typeof m.install === 'function' ||
      typeof m.activate === 'function' ||
      typeof m.deactivate === 'function' ||
      typeof m.uninstall === 'function' ||
      typeof m.migrate === 'function'
    )
  }
  return isPluginModule(def) ? def : root
}

globalThis.__runLifecycle = async function runLifecycle(hook) {
  const mod = __resolvePluginModule()
  const fn = mod && mod[hook]
  if (typeof fn !== 'function') return
  await fn(globalThis.__buildApi())
}

globalThis.__runMigrate = async function runMigrate(fromVersion) {
  const mod = __resolvePluginModule()
  const fn = mod && mod.migrate
  if (typeof fn !== 'function') return
  await fn({ fromVersion: fromVersion }, globalThis.__buildApi())
}

/**
 * Materialize host-serialized multipart file markers
 * (`{ __file: true, name, type, size, dataBase64 }` — see
 * `protocol/messages.ts:SerializedUploadedFile`) into the file facade route
 * handlers receive: `{ name, type, size, arrayBuffer(), text() }`. Bytes are
 * decoded lazily so text-only handlers never pay for the base64 decode.
 * Recurses through arrays (repeated form fields) and leaves every other
 * value untouched.
 */
function __materializeUploadedFiles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(__materializeUploadedFiles)
  if (!value || typeof value !== 'object') return value
  const marker = value as { __file?: unknown; name?: unknown; type?: unknown; size?: unknown; dataBase64?: unknown }
  if (marker.__file !== true || typeof marker.dataBase64 !== 'string') return value
  const dataBase64 = marker.dataBase64
  return {
    name: String(marker.name ?? ''),
    type: String(marker.type ?? ''),
    size: typeof marker.size === 'number' ? marker.size : 0,
    arrayBuffer: async function () {
      const bytes = __base64ToBytes(dataBase64)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
    text: async function () { return new TextDecoder().decode(__base64ToBytes(dataBase64)) },
  }
}

/**
 * Encode a raw-response escape hatch (`{ __response: true, ... }`) for the
 * wire. String bodies travel as UTF-8 text; ArrayBuffer / TypedArray /
 * DataView bodies travel base64-tagged so the host reconstructs the exact
 * bytes. Any other body type is a plugin bug — surface it loudly.
 */
function __encodeResponseBody(body: unknown): { body: string; bodyEncoding: 'utf8' | 'base64' } {
  if (body === null || body === undefined) return { body: '', bodyEncoding: 'utf8' }
  if (typeof body === 'string') return { body: body, bodyEncoding: 'utf8' }
  if (body instanceof ArrayBuffer) {
    return { body: __bytesToBase64(new Uint8Array(body)), bodyEncoding: 'base64' }
  }
  if (ArrayBuffer.isView(body)) {
    return {
      body: __bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      bodyEncoding: 'base64',
    }
  }
  throw new TypeError(
    'Route __response body must be a string, ArrayBuffer, or TypedArray/DataView (got '
    + Object.prototype.toString.call(body).slice(8, -1) + ')',
  )
}

globalThis.__runRoute = async function runRoute(routeKey, ctxJson) {
  const handler = globalThis.__plugin_handlers.routes[routeKey]
  if (!handler) throw new Error('Route handler not registered: ' + routeKey)
  const ctx = fromJson(ctxJson)
  // Build a case-insensitive Headers-like facade from the plain
  // Record<string, string> the host passes. Normalising to lowercase once
  // here matches the WHATWG Headers.get() semantics plugins expect.
  const _hdrs = ctx.request.headers || {}
  const _hdrsLc: Record<string, unknown> = {}
  for (const _k in _hdrs) {
    if (Object.prototype.hasOwnProperty.call(_hdrs, _k))
      _hdrsLc[String(_k).toLowerCase()] = _hdrs[_k]
  }
  const headersFacade = {
    get: function (name: unknown) {
      const k = String(name).toLowerCase()
      return Object.prototype.hasOwnProperty.call(_hdrsLc, k) ? _hdrsLc[k] : null
    },
    has: function (name: unknown) {
      return Object.prototype.hasOwnProperty.call(_hdrsLc, String(name).toLowerCase())
    },
    entries: function () { return Object.entries(_hdrsLc) },
    keys:    function () { return Object.keys(_hdrsLc) },
    values:  function () { return Object.values(_hdrsLc) },
    forEach: function (cb: (value: unknown, key: string) => void) {
      Object.keys(_hdrsLc).forEach(function (k) { cb(_hdrsLc[k], k) })
    },
  }
  // The raw body crosses the boundary byte-safely: UTF-8 text verbatim,
  // anything else base64-tagged (see protocol/bodyEncoding.ts). Decode
  // lazily per accessor so the common JSON route never touches base64.
  const rawBody: string = ctx.request.body || ''
  const bodyIsBase64 = ctx.request.bodyEncoding === 'base64'
  function requestBodyText(): string {
    return bodyIsBase64 ? new TextDecoder().decode(__base64ToBytes(rawBody)) : rawBody
  }
  const req = {
    url: ctx.request.url,
    method: ctx.request.method,
    headers: headersFacade,
    json: async function () { return fromJson(requestBodyText() || '{}') },
    text: async function () { return requestBodyText() },
    arrayBuffer: async function () {
      const bytes = bodyIsBase64 ? __base64ToBytes(rawBody) : new TextEncoder().encode(rawBody)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
  const body: Record<string, unknown> = {}
  for (const key of Object.keys(ctx.body || {})) {
    body[key] = __materializeUploadedFiles(ctx.body[key])
  }
  const result = await handler({ req: req, body: body, user: ctx.user })
  if (
    result && typeof result === 'object' &&
    (result as { __response?: unknown }).__response === true
  ) {
    const r = result as { status?: unknown; headers?: unknown; body?: unknown }
    const encoded = __encodeResponseBody(r.body)
    return toJson({
      __response: true,
      status: typeof r.status === 'number' ? r.status : 200,
      headers: r.headers && typeof r.headers === 'object' ? r.headers : {},
      body: encoded.body,
      bodyEncoding: encoded.bodyEncoding,
    })
  }
  return toJson(result, { ok: true })
}

globalThis.__runHookListener = async function runHookListener(listenerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.listeners[listenerId]
  if (!fn) return
  await fn(fromJson(payloadJson))
}

globalThis.__runHookFilter = async function runHookFilter(filterId, valueJson, contextJson) {
  const fn = globalThis.__plugin_handlers.filters[filterId]
  if (!fn) return valueJson
  const value = fromJson(valueJson)
  // Merge host-supplied context extras (siteId, pageId, slug, …) with the
  // always-present pluginId. The contextJson argument is optional — older
  // callers that don't pass it get a clean { pluginId } context.
  const contextExtras = contextJson ? fromJson(contextJson) : {}
  const context = Object.assign({ pluginId: globalThis.__plugin_meta.id }, contextExtras)
  const next = await fn(value, context)
  return toJson(next, value)
}

globalThis.__runLoopFetch = async function runLoopFetch(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId]
  if (!source) throw new Error('Loop source not registered: ' + sourceId)
  const result = await source.fetch(fromJson(ctxJson))
  // Fallback for a fetch() that forgets to return: send the empty result shape
  // the host's runLoopFetch parses back ({ items, totalItems }) rather than the
  // JS `undefined` primitive, which would make the host's evalString throw a
  // cryptic "not a string". Every data-returning dispatcher supplies a fallback.
  return toJson(result, { items: [], totalItems: 0 })
}

globalThis.__runLoopPreview = function runLoopPreview(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId]
  if (!source) throw new Error('Loop source not registered: ' + sourceId)
  const result = source.preview(fromJson(ctxJson))
  // preview() is contractually SYNCHRONOUS — the host calls it via a sync eval.
  // An async preview returns a Promise, which JSON.stringify flattens to '{}',
  // and the host would silently parse that to an empty preview. Surface the
  // author's bug loudly instead of swallowing it.
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    throw new TypeError('Loop source "' + sourceId + '" preview() must be synchronous (it returned a Promise)')
  }
  // Fallback for a preview() that forgets to return: '[]' (the empty array the
  // host parses) instead of the JS `undefined` primitive that would crash the
  // host's evalString.
  return toJson(result, [])
}

/**
 * Fire a scheduled job. Resolves with no value on success; throws on
 * handler error. The host wraps this call in its eval deadline (set per
 * schedule to maxDurationMs) so a runaway handler is interrupted cleanly.
 *
 * Lookup uses the namespaced id (e.g. 'acme.uptime.check-urls') because
 * scheduleRegister stores handlers under that key — mirroring the host's
 * pluginScheduleRegistration namespacing so both sides agree.
 *
 * If the handler isn't registered (e.g. plugin upgraded between tick and
 * dispatch, or the schedule row outlived a deactivate), we log and no-op
 * rather than throw — the schedule row will eventually be GC'd by the
 * host once the boot-claim grace window expires. We log so the silent
 * no-op surfaces during development if the handler-key ever drifts again.
 */
globalThis.__runSchedule = async function runSchedule(scheduleId) {
  const handler = globalThis.__plugin_handlers.schedules[scheduleId]
  if (typeof handler !== 'function') {
    __log('warn', 'no handler registered for schedule "' + String(scheduleId) + '"')
    return
  }
  await handler()
}

/**
 * Generic adapter dispatch. The host calls this when it needs to invoke a
 * method on a plugin-registered MediaStorageAdapter (beginWrite, finalizeWrite,
 * abortWrite, delete, getReadUrl, verify). One runner instead of six so the
 * dispatcher's surface stays narrow and the per-method routing happens
 * inside the VM via a property lookup on the handler bag.
 *
 * argsJson is the JSON-encoded argument array for the method (so
 * beginWrite receives one object, delete receives one string, etc.). The
 * runner returns JSON-stringified value so the host's evalString helper
 * can carry the result back.
 */
globalThis.__runMediaAdapterCall = async function runMediaAdapterCall(adapterId, method, argsJson) {
  const adapter = globalThis.__plugin_handlers.mediaAdapters[adapterId]
  if (!adapter) throw new Error('Media adapter not registered: ' + adapterId)
  const fn = adapter[method]
  if (typeof fn !== 'function') throw new Error('Media adapter "' + adapterId + '" does not implement "' + method + '"')
  const argsArray = fromJson(argsJson)
  // .apply doesn't work cleanly through QuickJS' function wrapping; spread
  // into a regular call. Adapter methods accept 0..2 arguments in v1.
  const result = await fn(argsArray[0], argsArray[1])
  return toJson(result, null)
}

globalThis.__runMediaUrlTransformer = async function runMediaUrlTransformer(transformerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.mediaUrlTransformers[transformerId]
  if (typeof fn !== 'function') {
    // Pass-through fallback. The host treats a null return as "no rewrite,
    // chain through to the next transformer's input value".
    return toJson(null)
  }
  const payload = fromJson(payloadJson)
  const next = await fn(payload.path, payload.ctx)
  return toJson(typeof next === 'string' ? next : null)
}

globalThis.__updateSettings = function updateSettings(nextJson) {
  const next = fromJson(nextJson)
  for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k]
  Object.assign(globalThis.__plugin_settings, next)
}

globalThis.__detectExportedHooks = function detectExportedHooks() {
  // Returns an Array (not a JSON string) because the host invokes this via
  // evalJson, which already wraps the result in JSON.stringify. Returning
  // a string would double-encode and the host would receive a string like
  // [["activate"]]. The runner-style helpers (__runRoute / __runLoopFetch
  // / ...) DO return JSON strings because their callers use evalString.
  const known = ['install', 'activate', 'deactivate', 'uninstall', 'migrate']
  const mod: Record<string, unknown> = __resolvePluginModule() || {}
  const out: string[] = []
  for (const name of known) {
    if (typeof mod[name] === 'function') out.push(name)
  }
  return out
}
