/**
 * Plugin module pack sandbox — server-side.
 *
 * Plugins that declare `entrypoints.modules` ship a bundle whose default
 * export is an array of `PluginModuleDefinition` objects (or a function
 * returning one). Each definition has a `render(props, children) => { html, css }`
 * that the publisher invokes per canvas node during page generation.
 *
 * Before this module existed, the host loaded module packs via
 * `await import(dataUrl)` — running the bundle in-host with full Bun/Node
 * privileges. That was a complete RCE bypass: a malicious plugin could put
 * its payload in `entrypoints.modules` and skip the server-entrypoint
 * sandbox entirely. This file closes that hole by running the module pack
 * inside a QuickJS-WASM context exactly like server entrypoints.
 *
 * What runs inside the VM:
 *   - The pack's bundled JS (wrapped to attach to `globalThis.__module_pack`)
 *   - The pack's `render()` functions, invoked per node during publish
 *
 * What stays in the host:
 *   - Module metadata (id, name, schema, defaults, htmlTag, …) — copied out
 *     as JSON-serializable values at activation time
 *   - The host's `ModuleDefinition` wrapping (registry, error boundaries,
 *     React component factory for editor preview — already host-only)
 *
 * Performance note: render is called possibly hundreds of times per publish,
 * and per request for Layer C holes. Each call goes through a persistent
 * function handle (`callStringSync`) — props and accumulated children HTML
 * cross the boundary as plain string arguments (`ctx.newString` memcpys),
 * never as payload-sized JS source the WASM interpreter would have to
 * compile per call.
 */

import type { QuickJSHandle } from 'quickjs-emscripten'
import { MODULE_PACK_BOOTSTRAP_SOURCE } from './quickjs/bootstrap/generated/modulePackBootstrap'
import { getWasmModule } from './quickjs/vm'
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_STACK_SIZE_BYTES,
  MODULE_PACK_EVAL_TIMEOUT_MS,
} from './quickjs/limits'
import { callStringSync, evalStringSync, withSyncDeadline } from './quickjs/eval'
import { wrapEsmAsGlobal } from './quickjs/esmShim'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Render output — must match `PluginRenderOutput` in the SDK. We restate it
 * here so this file stays free of the SDK dependency graph; mismatches would
 * be caught by the type system at the call site.
 */
export interface ModulePackRenderOutput {
  html: string
  css?: string
  js?: string
}

/**
 * Module metadata as it exits the VM. Mirrors `PluginModuleDefinition` minus
 * the function fields (`render`, `preview`) — those live inside the VM and
 * are invoked through `vm.render(...)` / `vm.preview(...)`.
 *
 * `dependencies` and `editorRuntime` are both JSON-serializable shapes
 * declared by plugin modules (see `PluginModuleDependencies` /
 * `PluginEditorRuntime` in the SDK). They cross the VM boundary so the host
 * can write deps into the site's package.json and wire up the editor
 * iframe preview's import map.
 */
export interface SerializedModuleDefinition {
  id: string
  name: string
  description?: string
  category: string
  version: string
  defaults: Record<string, unknown>
  schema: Record<string, unknown>
  canHaveChildren?: boolean
  htmlTag?: string
  hasPreview: boolean
  dependencies?: Record<string, string | { version: string; dev?: boolean }>
  editorRuntime?: { sandbox?: { source: string; minHeight?: number } }
}

export interface ModulePackVm {
  readonly pluginId: string
  readonly modules: ReadonlyArray<SerializedModuleDefinition>
  render(moduleId: string, props: Record<string, unknown>, children: string[]): ModulePackRenderOutput
  preview(moduleId: string, props: Record<string, unknown>, children: string[]): ModulePackRenderOutput
  dispose(): void
}

// ---------------------------------------------------------------------------
// Bootstrap source — initializes the pack and exposes invocation entries
// (__initPack, __renderModule, __previewModule + a silent console stub).
//
// Authored as real TypeScript in `quickjs/bootstrap/src/modulePackRuntime.ts`
// and bundled to the committed string `MODULE_PACK_BOOTSTRAP_SOURCE` by
// `scripts/sync-plugin-bootstrap.ts` (regenerate with `bun run bootstrap:sync`).
// The shared host⇄VM JSON marshaling (`bootstrap/src/boundary.ts`) is inlined
// into both this and the full-plugin bootstrap — one source-level definition.
//
// The leading `'use strict';` makes the whole evaluated program strict,
// matching the original inline bootstrap.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SOURCE = `'use strict';\n` + MODULE_PACK_BOOTSTRAP_SOURCE

// ---------------------------------------------------------------------------
// VM construction
// ---------------------------------------------------------------------------

/**
 * Build a sandboxed module pack VM from the pack's bundled source.
 *
 * Throws if the pack's bootstrap or default-export resolution fails — the
 * caller (lifecycle handler) should mark the plugin's `lifecycleStatus` as
 * `error` and surface the message.
 */
export async function createModulePackVm(args: {
  pluginId: string
  packSource: string
}): Promise<ModulePackVm> {
  const wasm = await getWasmModule()
  const ctx = wasm.newContext()

  // Apply per-VM resource limits before any plugin code runs.
  // setMemoryLimit / setMaxStackSize bind to the runtime; each newContext()
  // creates its own runtime, so these limits are effectively per-VM.
  ctx.runtime.setMemoryLimit(DEFAULT_MEMORY_LIMIT_BYTES)
  ctx.runtime.setMaxStackSize(DEFAULT_STACK_SIZE_BYTES)

  // Persistent dispatcher handles, populated after the bootstrap evaluates.
  // Tracked outside the try so the failure path can release them before
  // tearing down the context.
  const dispatcherHandles: QuickJSHandle[] = []

  try {
    // Evaluate the pack — the shared ESM shim maps its default export to a
    // `globalThis.__module_pack = ...` assignment.
    const wrappedSource = wrapEsmAsGlobal(args.packSource, '__module_pack', { unwrapDefault: true })
    withSyncDeadline(ctx, MODULE_PACK_EVAL_TIMEOUT_MS, () => {
      ctx.unwrapResult(ctx.evalCode(wrappedSource, `module-pack:${args.pluginId}`)).dispose()
    })

    // Then the bootstrap (defines __initPack, __renderModule, __previewModule).
    withSyncDeadline(ctx, MODULE_PACK_EVAL_TIMEOUT_MS, () => {
      ctx.unwrapResult(ctx.evalCode(BOOTSTRAP_SOURCE, 'modulepack-bootstrap.js')).dispose()
    })

    // Persistent handles to the bootstrap's render/preview dispatchers —
    // every render() call goes through ctx.callFunction on these instead of
    // compiling a payload-sized source string. Released in dispose().
    const renderHandle = ctx.getProp(ctx.global, '__renderModule')
    const previewHandle = ctx.getProp(ctx.global, '__previewModule')
    dispatcherHandles.push(renderHandle, previewHandle)

    // Initialize the pack — pulls metadata out, builds the id-keyed lookup.
    const modulesJson = evalStringSync(
      ctx,
      `JSON.stringify(__initPack(${JSON.stringify(args.pluginId)}))`,
      MODULE_PACK_EVAL_TIMEOUT_MS,
      'modulepack-eval.js',
    )
    const modules = JSON.parse(modulesJson) as SerializedModuleDefinition[]

    const pluginId = args.pluginId

    return {
      pluginId,
      modules,

      render(moduleId, props, children) {
        const result = callStringSync(
          ctx,
          renderHandle,
          [moduleId, JSON.stringify(props), JSON.stringify(children)],
          MODULE_PACK_EVAL_TIMEOUT_MS,
        )
        return JSON.parse(result) as ModulePackRenderOutput
      },

      preview(moduleId, props, children) {
        const result = callStringSync(
          ctx,
          previewHandle,
          [moduleId, JSON.stringify(props), JSON.stringify(children)],
          MODULE_PACK_EVAL_TIMEOUT_MS,
        )
        return JSON.parse(result) as ModulePackRenderOutput
      },

      dispose() {
        try { if (renderHandle.alive) renderHandle.dispose() } catch {/* already disposed */}
        try { if (previewHandle.alive) previewHandle.dispose() } catch {/* already disposed */}
        try { ctx.dispose() } catch {/* already disposed */}
      },
    }
  } catch (err) {
    for (const handle of dispatcherHandles) {
      try { if (handle.alive) handle.dispose() } catch {/* ignore */}
    }
    try { ctx.dispose() } catch {/* ignore */}
    throw err
  }
}
