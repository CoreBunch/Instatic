/**
 * Ambient declarations for the QuickJS plugin sandbox bootstrap.
 *
 * These are the globals that exist INSIDE a plugin VM — they are either:
 *   - host-injected before the bootstrap evaluates (`vm.ts` wires `__hostCall`,
 *     `__log`, `__plugin_meta`, `__plugin_settings`, `__plugin_exports`), or
 *   - entry points the bootstrap installs on `globalThis` so the host can call
 *     them by name (`__runRoute`, `__detectExportedHooks`, `__initPack`, …).
 *
 * Declaring them here lets the bootstrap source (`pluginRuntime.ts`,
 * `modulePackRuntime.ts`) be authored as real, typed, lintable TypeScript even
 * though none of these symbols exist in the host's own global scope. The
 * authoring surface is bundled to a string by `scripts/sync-plugin-bootstrap.ts`
 * and only ever runs inside the sandbox.
 */

declare global {
  /** A handler the plugin registered; called dynamically by the runners. */
  type BootstrapFn = (...args: unknown[]) => unknown

  /**
   * A dynamic, plugin-supplied argument crossing into the VM (loop source,
   * schedule def, media adapter, …). The bootstrap validates its shape at
   * runtime (the `typeof x.foo !== 'function'` guards), so it is genuinely
   * untyped at the boundary — exactly the value `JSON`-style dynamic dispatch
   * works on.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PluginInput = any

  /** Live in-VM registries of plugin-supplied handlers (host holds only metadata). */
  interface PluginHandlerRegistry {
    routes: Record<string, BootstrapFn>
    listeners: Record<string, BootstrapFn>
    filters: Record<string, BootstrapFn>
    loopSources: Record<string, { fetch: BootstrapFn; preview: BootstrapFn }>
    schedules: Record<string, BootstrapFn>
    mediaAdapters: Record<string, Record<string, BootstrapFn | null>>
    mediaUrlTransformers: Record<string, BootstrapFn>
  }

  /**
   * Plugin identity + authority injected by the host. `grantedPermissions` is
   * the AUTHORITATIVE set the operator approved at install time — the VM-side
   * permission check validates against it, agreeing with the host-side and
   * editor-side checks. The plugin's DECLARED `permissions` array is consumed
   * by the host's install/consent UI and never enters the VM.
   */
  interface PluginMeta {
    id: string
    version: string
    grantedPermissions: string[]
    assetBasePath?: string
  }

  /** A canvas module definition as it lives inside the pack VM. */
  interface ModulePackEntry {
    render?: BootstrapFn
    preview?: BootstrapFn
    [key: string]: unknown
  }

  // --- host-injected (wired by vm.ts before the bootstrap evaluates) -------
  var __hostCall: (target: string, args: unknown[]) => Promise<unknown>
  var __log: (level: string, message: string) => void
  var __plugin_meta: PluginMeta
  var __plugin_settings: Record<string, string | number | boolean>
  var __plugin_exports: Record<string, unknown> | undefined

  // --- string-shim helpers (full-plugin VM only) ----------------------------
  // Defined by `bootstrap/base64.ts`, which BOOTSTRAP_SOURCE evaluates before
  // the bundled runtime. NOT part of the module-pack VM's bootstrap —
  // `modulePackRuntime.ts` must not reference them.
  var __bytesToBase64: (bytes: Uint8Array) => string
  var __base64ToBytes: (base64: string) => Uint8Array

  // --- full-plugin runtime entry points (installed by pluginRuntime.ts) ----
  var __plugin_handlers: PluginHandlerRegistry
  var __buildApi: () => unknown
  var __runLifecycle: (hook: string) => Promise<void>
  var __runMigrate: (fromVersion: string) => Promise<void>
  var __runRoute: (routeKey: string, ctxJson: string) => Promise<string>
  var __runHookListener: (listenerId: string, payloadJson: string) => Promise<void>
  var __runHookFilter: (filterId: string, valueJson: string, contextJson?: string) => Promise<string>
  var __runLoopFetch: (sourceId: string, ctxJson: string) => Promise<string>
  var __runLoopPreview: (sourceId: string, ctxJson: string) => string
  var __runSchedule: (scheduleId: string) => Promise<void>
  var __runMediaAdapterCall: (adapterId: string, method: string, argsJson: string) => Promise<string>
  var __runMediaUrlTransformer: (transformerId: string, payloadJson: string) => Promise<string>
  var __updateSettings: (nextJson: string) => void
  var __detectExportedHooks: () => string[]

  // --- module-pack runtime entry points (installed by modulePackRuntime.ts) -
  var __module_pack: unknown
  var __modules: Record<string, ModulePackEntry>
  var __initPack: (pluginId: string) => unknown
  var __renderModule: (moduleId: string, propsJson: string, childrenJson: string) => string
  var __previewModule: (moduleId: string, propsJson: string, childrenJson: string) => string
}

export {}
