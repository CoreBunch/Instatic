/**
 * QuickJS VM factory — creates a sandboxed plugin context, evaluates the
 * bootstrap + plugin source, wires host functions, and returns a PluginVm.
 *
 * Sandbox topology:
 *   ┌─ Bun host (main process)
 *   │  ┌─ Bun.Worker (crash isolation, CPU yield)
 *   │  │  ┌─ QuickJS-WASM context (security sandbox — THIS file)
 *   │  │  │  ┌─ Bootstrap (SDK facade + handler registries + minimal runtime)
 *   │  │  │  └─ Plugin source (IIFE → globalThis.__plugin_exports)
 *   │  │  └─ Host functions: __hostCall, __hostSleep, __log
 *   │  └─ protocol/ wire format
 *   └─ host/ api-call dispatch
 *
 * Concurrency model — sync QuickJS variant + deferred VM promises:
 *
 *   - The synchronous WASM variant of QuickJS is used (NOT the asyncified one).
 *     Asyncify's stack-unwinding interacts badly with Bun's microtask scheduler
 *     under load (manifests as `p->ref_count == 0` assertions on the second
 *     async eval). The sync variant is rock-stable.
 *   - `__hostCall` is registered as a *synchronous* VM function. When the
 *     plugin invokes it, the host creates a VM-side `Promise` via
 *     `ctx.newPromise()`, kicks off the real async work, and returns the
 *     Promise handle immediately. When the host work completes,
 *     `deferred.resolve(...)` lands the value into the VM and triggers any
 *     queued `.then` continuations.
 *   - The host drains the VM's microtask queue via
 *     `runtime.executePendingJobs()` after each settle and during eval polling.
 */

import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten'
import { BOOTSTRAP_SOURCE } from './bootstrap/index'
import { DEFAULT_EVAL_TIMEOUT_MS, DEFAULT_MEMORY_LIMIT_BYTES, DEFAULT_STACK_SIZE_BYTES } from './limits'
import { jsToHandle } from './marshal'
import { callString, callVoid, evalJson, withSyncDeadline } from './eval'
import type { PluginVm, PluginVmEnv } from './types'

export type { PluginVm, PluginVmEnv } from './types'

/**
 * The bootstrap's `__run*` dispatcher entry points. The host grabs a
 * persistent function handle for each one right after the bootstrap
 * evaluates and dispatches every call through `ctx.callFunction` (see
 * `callString` / `callVoid` in `eval.ts`). Payloads cross the boundary as
 * plain string arguments — `ctx.newString` is a memcpy — instead of being
 * embedded in payload-sized JS source that QuickJS (WASM-interpreted)
 * would have to tokenize and compile on every call.
 */
const DISPATCHER_NAMES = [
  '__runLifecycle',
  '__runMigrate',
  '__runRoute',
  '__runHookListener',
  '__runHookFilter',
  '__runLoopFetch',
  '__runLoopPreview',
  '__runSchedule',
  '__updateSettings',
  '__runMediaAdapterCall',
  '__runMediaUrlTransformer',
] as const

type DispatcherName = (typeof DISPATCHER_NAMES)[number]

// ---------------------------------------------------------------------------
// Singleton WASM module — one per worker, shared across every QuickJS context
// (full-plugin VMs here and module-pack VMs in `modulePackVm.ts`). The
// quickjs-emscripten library caches the compiled module internally, so this
// accessor just memoizes the in-flight load promise.
// ---------------------------------------------------------------------------

let wasmModulePromise: Promise<QuickJSWASMModule> | null = null

export function getWasmModule(): Promise<QuickJSWASMModule> {
  if (!wasmModulePromise) wasmModulePromise = getQuickJS()
  return wasmModulePromise
}

// ---------------------------------------------------------------------------
// VM factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh QuickJS context for a plugin, evaluate the bootstrap, wire
 * in host functions, evaluate the plugin source bundle, and return a
 * `PluginVm` with strongly-typed entry points. Caller MUST `dispose()` when
 * the plugin is unloaded.
 *
 * Plugin source MUST be an IIFE that attaches its lifecycle hooks to
 * `globalThis.__plugin_exports`. The SDK build pipeline produces this shape
 * for server bundles — see `src/core/plugin-sdk/cli/build.ts`.
 */
export async function createPluginVm(args: {
  pluginSource: string
  env: PluginVmEnv
  evalTimeoutMs?: number
}): Promise<PluginVm> {
  const wasm = await getWasmModule()
  const ctx = wasm.newContext()
  const evalTimeoutMs = args.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS

  // Apply per-plugin resource limits BEFORE evaluating any plugin code.
  // setMemoryLimit / setMaxStackSize live on the runtime, not the context,
  // and bind to all contexts created from this runtime. Each `wasm.newContext`
  // creates its own runtime in this binding, so limits are effectively
  // per-plugin.
  ctx.runtime.setMemoryLimit(DEFAULT_MEMORY_LIMIT_BYTES)
  ctx.runtime.setMaxStackSize(DEFAULT_STACK_SIZE_BYTES)
  /**
   * Host function handles MUST be kept alive for the lifetime of the
   * context — QuickJS's emscripten binding holds them via a HostRefMap and
   * disposing the JS-side handle early invalidates the in-VM callable.
   * They get released alongside the context in `dispose()` below.
   */
  const hostFunctionHandles: QuickJSHandle[] = []

  /**
   * Persistent handles to the bootstrap's `__run*` dispatchers, populated
   * right after the bootstrap evaluates — BEFORE the plugin bundle runs, so
   * a plugin that reassigns `globalThis.__runRoute` cannot intercept host
   * dispatch. Owned handles; released in `dispose()` alongside
   * `hostFunctionHandles`.
   */
  const dispatcherHandles = new Map<DispatcherName, QuickJSHandle>()
  const dispatcher = (name: DispatcherName): QuickJSHandle => {
    const handle = dispatcherHandles.get(name)
    // Populated for every name during createPluginVm; missing only if a
    // dispatch were attempted before the bootstrap evaluated.
    if (!handle) throw new Error(`VM dispatcher ${name} is not initialized`)
    return handle
  }

  /**
   * Pending host-side timers. Bun.setTimeout returns a Timer handle (Node-
   * compatible) that we keep here so `dispose()` can stop every in-flight
   * fire before tearing down the VM — otherwise a timer scheduled by the
   * plugin would fire into a dead context and crash the worker.
   *
   * We use any-typed handles because the cross-platform Timer / Timeout
   * shape differs between Bun, Node, and the WebWorker DOM lib. We only
   * pass them to clearTimeout, which accepts all three.
   */
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * Set to true by `dispose()`. Used by the __hostCall / __hostSleep
   * callbacks as a cheap pre-check before touching VM handles, so a host
   * promise that resolves moments after `dispose()` can drop silently
   * instead of trying to call `ctx.newObject()` on a freed context (which
   * fails with "Lifetime not alive").
   */
  let vmDisposed = false

  /**
   * Pending VM-side `Deferred`s created by `__hostCall` / `__hostSleep`.
   * Each `ctx.newPromise()` allocates VM-tracked handles for the resolve
   * and reject callbacks; if the VM is disposed while one is unsettled,
   * QuickJS asserts `list_empty(&rt->gc_obj_list)` at runtime-free time
   * because those handles are still in the GC list. Disposing the deferred
   * up front in `vm.dispose()` releases them cleanly. Deferreds are
   * removed once they settle (resolve / reject paths handle this).
   */
  const pendingDeferreds = new Set<ReturnType<QuickJSContext['newPromise']>>()

  /**
   * Drain the VM's microtask queue under a wall-clock deadline. Host-call
   * resolutions and timer fires pump plugin continuations OUTSIDE any
   * `evalResolved` deadline (e.g. a `setInterval` callback firing long
   * after the eval that scheduled it returned), so each pump carries its
   * own deadline — a `while (true) {}` inside a timer callback is
   * interrupted instead of wedging the worker thread forever. A job the
   * queue reports as failed (interrupted or otherwise uncaught) is logged
   * with the plugin prefix and dropped; the VM stays usable.
   */
  const pumpPendingJobs = (): void => {
    withSyncDeadline(ctx, evalTimeoutMs, () => {
      const result = ctx.runtime.executePendingJobs()
      if ('error' in result && result.error) {
        const dumped = result.error.consume((handle) => ctx.dump(handle)) as
          | { message?: string; stack?: string }
          | string
          | undefined
        const message = typeof dumped === 'object' && dumped?.message ? dumped.message : String(dumped)
        const stack = typeof dumped === 'object' && typeof dumped?.stack === 'string' ? `\n${dumped.stack}` : ''
        console.error(`[plugin:${args.env.pluginId}] VM job aborted: ${message}${stack}`)
      }
    })
  }

  try {
    // 1. Wire __hostCall as a SYNCHRONOUS VM function. The host returns a
    //    VM-side Promise immediately and resolves it later from JS-land.
    //    `runtime.executePendingJobs()` drives any queued plugin-side .then
    //    continuations after the resolve lands.
    const hostCallHandle = ctx.newFunction('__hostCall', (targetHandle, argsHandle) => {
      const target = ctx.getString(targetHandle)
      const dumpedArgs = ctx.dump(argsHandle) as unknown
      const argsArray = Array.isArray(dumpedArgs) ? dumpedArgs : []

      const deferred = ctx.newPromise()
      pendingDeferreds.add(deferred)
      args.env.hostCall(target, argsArray).then(
        (value) => {
          // If the VM was disposed while we were awaiting (e.g. plugin
          // upgrade, crash, uninstall) drop the result silently — there's
          // no one to deliver to, and touching context handles would crash.
          // The try/catch protects against the gap between deferred being
          // marked dead and the underlying context lifetime being invalidated.
          if (vmDisposed || !deferred.alive) {
            pendingDeferreds.delete(deferred)
            return
          }
          try {
            const valueHandle = jsToHandle(ctx, value)
            deferred.resolve(valueHandle)
            if (valueHandle !== ctx.undefined && valueHandle !== ctx.null && valueHandle !== ctx.true && valueHandle !== ctx.false) {
              valueHandle.dispose()
            }
            // Drain plugin-side microtasks queued by the resolve.
            pumpPendingJobs()
          } catch { /* VM gone — silent drop. */ }
          pendingDeferreds.delete(deferred)
        },
        (err) => {
          if (vmDisposed || !deferred.alive) {
            pendingDeferreds.delete(deferred)
            return
          }
          try {
            const message = err instanceof Error ? err.message : String(err)
            const errHandle = ctx.newError(message)
            deferred.reject(errHandle)
            errHandle.dispose()
            pumpPendingJobs()
          } catch { /* VM gone — silent drop. */ }
          pendingDeferreds.delete(deferred)
        },
      )
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__hostCall', hostCallHandle)
    hostFunctionHandles.push(hostCallHandle)

    // 1b. Wire __hostSleep — sync VM function that returns a VM Promise
    //     resolved after `ms` real wall-clock milliseconds. Used by the
    //     bootstrap's setTimeout/setInterval polyfills. Worker-local
    //     setTimeout (no IPC roundtrip to the main thread).
    const hostSleepHandle = ctx.newFunction('__hostSleep', (msHandle) => {
      const ms = ctx.getNumber(msHandle)
      const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0
      const deferred = ctx.newPromise()
      pendingDeferreds.add(deferred)
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        if (vmDisposed || !deferred.alive) {
          pendingDeferreds.delete(deferred)
          return
        }
        try {
          deferred.resolve(ctx.undefined)
          pumpPendingJobs()
        } catch { /* VM gone — silent drop. */ }
        pendingDeferreds.delete(deferred)
      }, safeMs)
      pendingTimers.add(timer)
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__hostSleep', hostSleepHandle)
    hostFunctionHandles.push(hostSleepHandle)

    // 2. Wire __log — fire-and-forget log channel.
    const logHandle = ctx.newFunction('__log', (levelHandle, messageHandle) => {
      const level = ctx.getString(levelHandle)
      const message = ctx.getString(messageHandle)
      args.env.log([`[${level}]`, message])
    })
    ctx.setProp(ctx.global, '__log', logHandle)
    hostFunctionHandles.push(logHandle)

    // 3. Wire meta + settings as VM globals.
    //
    //    `grantedPermissions` is the AUTHORITATIVE set the operator approved at
    //    install time. The VM-side `assertPermission` (bootstrap) validates
    //    against THIS — not the declared `permissions` array — so the VM, the
    //    host dispatcher (`assertHostPluginPermission`), and the editor SDK
    //    (`assertPluginPermission`) all agree on one authority. The declared
    //    `permissions` array is consumed only by the host's install/consent UI
    //    and intentionally never enters the VM.
    const metaHandle = jsToHandle(ctx, {
      id: args.env.pluginId,
      version: args.env.manifestVersion,
      grantedPermissions: args.env.grantedPermissions,
      assetBasePath: args.env.assetBasePath,
    })
    ctx.setProp(ctx.global, '__plugin_meta', metaHandle)
    metaHandle.dispose()

    const settingsHandle = jsToHandle(ctx, { ...args.env.settings })
    ctx.setProp(ctx.global, '__plugin_settings', settingsHandle)
    settingsHandle.dispose()

    // 4. Evaluate the bootstrap and plugin bundle — both under the
    //    wall-clock interrupt deadline (mirrors modulePackVm.ts). Without
    //    it, a plugin bundle with a top-level `while (true) {}` would wedge
    //    the worker thread before any other guard could engage.
    withSyncDeadline(ctx, evalTimeoutMs, () => {
      ctx.unwrapResult(ctx.evalCode(BOOTSTRAP_SOURCE, 'instatic-bootstrap.js')).dispose()
    })
    // Grab the dispatcher function handles the bootstrap just installed.
    for (const name of DISPATCHER_NAMES) {
      dispatcherHandles.set(name, ctx.getProp(ctx.global, name))
    }
    withSyncDeadline(ctx, evalTimeoutMs, () => {
      ctx.unwrapResult(ctx.evalCode(args.pluginSource, `plugin:${args.env.pluginId}`)).dispose()
    })

    // 5. Detect which lifecycle hooks the plugin exported.
    const exportedHooks = await evalJson<Array<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>>(
      ctx,
      `__detectExportedHooks()`,
      evalTimeoutMs,
    )

    const pluginId = args.env.pluginId

    return {
      pluginId,
      exportedHooks,

      async runLifecycle(hook) {
        await callVoid(ctx, dispatcher('__runLifecycle'), [hook], evalTimeoutMs)
      },

      async runMigrate(fromVersion) {
        await callVoid(ctx, dispatcher('__runMigrate'), [fromVersion], evalTimeoutMs)
      },

      async runRoute(routeKey, routeCtx) {
        const json = await callString(
          ctx,
          dispatcher('__runRoute'),
          [routeKey, JSON.stringify(routeCtx)],
          evalTimeoutMs,
        )
        return JSON.parse(json) as unknown
      },

      async runHookListener(listenerId, payload) {
        await callVoid(
          ctx,
          dispatcher('__runHookListener'),
          [listenerId, JSON.stringify(payload ?? null)],
          evalTimeoutMs,
        )
      },

      async runHookFilter(filterId, value, context) {
        const valueJson = JSON.stringify(value ?? null)
        // Strip pluginId from context extras before sending — the bootstrap
        // re-adds it from __plugin_meta so we don't double-carry it over the
        // wire. The 'null' JSON string parses to a clean empty context.
        const contextExtras = context
          ? (({ pluginId: _p, ...rest }) => Object.keys(rest).length > 0 ? rest : undefined)(context as Record<string, unknown>)
          : undefined
        const contextJson = contextExtras !== undefined ? JSON.stringify(contextExtras) : 'null'
        const resultJson = await callString(
          ctx,
          dispatcher('__runHookFilter'),
          [filterId, valueJson, contextJson],
          evalTimeoutMs,
        )
        return JSON.parse(resultJson) as unknown
      },

      async runLoopFetch(sourceId, loopCtx) {
        const json = await callString(
          ctx,
          dispatcher('__runLoopFetch'),
          [sourceId, JSON.stringify(loopCtx ?? null)],
          evalTimeoutMs,
        )
        const parsed = JSON.parse(json) as { items?: unknown[]; totalItems?: number }
        return {
          items: Array.isArray(parsed.items) ? parsed.items : [],
          totalItems: typeof parsed.totalItems === 'number' ? parsed.totalItems : 0,
        }
      },

      async runLoopPreview(sourceId, loopCtx) {
        const json = await callString(
          ctx,
          dispatcher('__runLoopPreview'),
          [sourceId, JSON.stringify(loopCtx ?? null)],
          evalTimeoutMs,
        )
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? parsed : []
      },

      async runSchedule(scheduleId, maxDurationMs) {
        // Per-schedule deadline replaces the VM's default 5s budget for
        // this single call only — its registry token is released when the
        // call settles, so subsequent calls fall back to the default.
        await callVoid(ctx, dispatcher('__runSchedule'), [scheduleId], maxDurationMs ?? evalTimeoutMs)
      },

      async updateSettings(next) {
        await callVoid(ctx, dispatcher('__updateSettings'), [JSON.stringify(next)], evalTimeoutMs)
      },

      async runMediaAdapterCall(adapterId, method, callArgs) {
        const resultJson = await callString(
          ctx,
          dispatcher('__runMediaAdapterCall'),
          [adapterId, method, JSON.stringify(callArgs ?? [])],
          evalTimeoutMs,
        )
        return JSON.parse(resultJson) as unknown
      },

      async runMediaUrlTransformer(transformerId, payload) {
        const resultJson = await callString(
          ctx,
          dispatcher('__runMediaUrlTransformer'),
          [transformerId, JSON.stringify(payload)],
          evalTimeoutMs,
        )
        const parsed = JSON.parse(resultJson) as unknown
        return typeof parsed === 'string' ? parsed : null
      },

      dispose() {
        // Mark disposed FIRST so any host-call resolution arriving after
        // this call (the VM has no way to cancel in-flight host promises)
        // short-circuits before touching freed handles.
        vmDisposed = true
        // Stop pending timers next so a timer fire doesn't try to touch a
        // disposed context. The deferred.alive checks inside the fire
        // callback are belt-and-suspenders, but cancelling up front avoids
        // even calling them.
        for (const timer of pendingTimers) {
          try { clearTimeout(timer) } catch {/* ignore */}
        }
        pendingTimers.clear()
        // Dispose any still-pending deferreds. Each one owns VM-tracked
        // resolve/reject closures that count against the runtime's GC list;
        // leaving them alive trips a `list_empty(&rt->gc_obj_list)` assertion
        // at runtime-free time.
        for (const deferred of pendingDeferreds) {
          try { deferred.dispose() } catch {/* already disposed */}
        }
        pendingDeferreds.clear()
        for (const h of dispatcherHandles.values()) {
          try { if (h.alive) h.dispose() } catch {/* already disposed */}
        }
        dispatcherHandles.clear()
        for (const h of hostFunctionHandles) {
          try { if (h.alive) h.dispose() } catch {/* already disposed */}
        }
        try { ctx.dispose() } catch {/* already disposed */}
      },
    }
  } catch (err) {
    vmDisposed = true
    for (const timer of pendingTimers) {
      try { clearTimeout(timer) } catch {/* ignore */}
    }
    pendingTimers.clear()
    for (const deferred of pendingDeferreds) {
      try { deferred.dispose() } catch {/* ignore */}
    }
    pendingDeferreds.clear()
    for (const h of dispatcherHandles.values()) {
      try { if (h.alive) h.dispose() } catch {/* ignore */}
    }
    dispatcherHandles.clear()
    for (const h of hostFunctionHandles) {
      try { if (h.alive) h.dispose() } catch {/* ignore */}
    }
    try { ctx.dispose() } catch {/* ignore */}
    throw err
  }
}
