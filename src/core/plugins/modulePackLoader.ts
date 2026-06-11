/**
 * Plugin module pack loader.
 *
 * Activated alongside the plugin's editor entrypoint when the plugin has the
 * `modules.register` permission and `entrypoints.modules` set. The default
 * export of the module pack is either an array of `PluginModuleDefinition`
 * or a function that returns one. The host wraps each definition into a
 * full host `ModuleDefinition` (see `moduleAdapter.ts`) and registers it
 * with the canvas registry.
 *
 * The caller injects a `componentFactory` so the editor side can supply a
 * React-based preview component while the server side uses a stub. This
 * keeps `src/core/` free of runtime React imports (Constraint #179).
 *
 * Lifecycle:
 *   - `activatePluginModulePack(manifest, mod, componentFactory)` — register
 *     every module declared by the plugin pack.
 *   - `deactivatePluginModulePack(pluginId)` — unregister every module that
 *     was registered for this plugin id.
 */
import type { ComponentType } from 'react'
import { registry } from '@core/module-engine'
import type {
  ModuleComponentProps,
} from '@core/module-engine'
import type { PluginManifest } from '@core/plugin-sdk'
import type {
  PluginEditorRuntime,
  PluginModuleDefinition,
  PluginModuleDependencies,
  PluginModulePackEntrypoint,
  PluginModulesEntrypointModule,
} from '@core/plugin-sdk'
import { assertPluginPermission } from '@core/plugin-sdk'
import {
  pluginModuleToHostModule,
  PluginModuleValidationError,
  type PluginModuleComponentFactory,
} from './moduleAdapter'

/**
 * Track which module ids were registered by which plugin so we can remove
 * them cleanly on deactivate. Keyed by plugin id.
 */
const registeredByPlugin = new Map<string, Set<string>>()

// Live sandboxed VMs by plugin id. Tracked so every lifecycle teardown can
// dispose the QuickJS context — the emscripten runtime is not reclaimed by JS
// GC, so without this each activate/upgrade/restart cycle leaks one native
// context for the host-process lifetime (ISS-033). Stays empty on the browser
// editor path (activatePluginModulePack), where there is no VM.
const packsByPlugin = new Map<string, SandboxedModulePack>()

function resolveDefinitions(
  pluginId: string,
  entry: PluginModulePackEntrypoint,
): PluginModuleDefinition[] {
  const value = typeof entry === 'function' ? entry({ pluginId }) : entry
  if (!Array.isArray(value)) {
    throw new PluginModuleValidationError(
      `Plugin "${pluginId}" module pack entrypoint must default-export an array (or a function returning one).`,
      pluginId,
    )
  }
  return value
}

/**
 * Stub component used on the server. The publisher never reads
 * `definition.component`, but the type system requires one — so we hand back
 * an opaque `ComponentType` that throws if invoked. Type-only React imports
 * keep this file out of the runtime-React ban for `src/core/`.
 */
const STUB_COMPONENT_FACTORY: PluginModuleComponentFactory = () => {
  return ((): never => {
    throw new Error('Plugin module React component is not available on the server.')
  }) as unknown as ComponentType<ModuleComponentProps>
}

export function activatePluginModulePack(
  manifest: PluginManifest,
  mod: PluginModulesEntrypointModule,
  componentFactory: PluginModuleComponentFactory = STUB_COMPONENT_FACTORY,
): void {
  assertPluginPermission(manifest, 'modules.register')

  const definitions = resolveDefinitions(manifest.id, mod.default)
  // Replace any previous registrations for this plugin id atomically.
  deactivatePluginModulePack(manifest.id)
  const ids = new Set<string>()
  for (const definition of definitions) {
    const hostModule = pluginModuleToHostModule(
      manifest.id,
      definition,
      componentFactory,
      manifest.grantedPermissions ?? [],
    )
    registry.registerOrReplace(hostModule)
    ids.add(hostModule.id)
  }
  registeredByPlugin.set(manifest.id, ids)
}

export function deactivatePluginModulePack(pluginId: string): void {
  const pack = packsByPlugin.get(pluginId)
  if (pack) {
    try {
      pack.dispose()
    } catch (err) {
      console.error(`[plugin:${pluginId}] module pack dispose failed`, err)
    }
    packsByPlugin.delete(pluginId)
  }
  const ids = registeredByPlugin.get(pluginId)
  if (!ids) return
  for (const id of ids) registry.unregister(id)
  registeredByPlugin.delete(pluginId)
}

export function listPluginRegisteredModuleIds(pluginId: string): string[] {
  return [...(registeredByPlugin.get(pluginId) ?? [])]
}

export function resetPluginModulePacks(): void {
  for (const pack of packsByPlugin.values()) {
    try {
      pack.dispose()
    } catch (err) {
      console.error(`[plugin:${pack.pluginId}] module pack dispose failed`, err)
    }
  }
  packsByPlugin.clear()
  for (const ids of registeredByPlugin.values()) {
    for (const id of ids) registry.unregister(id)
  }
  registeredByPlugin.clear()
}

// ---------------------------------------------------------------------------
// Sandboxed activation — server-side
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a sandboxed module pack. Matches the shape of
 * `server/plugins/modulePackVm.ts:ModulePackVm` but is declared here so
 * `src/core/` stays free of the server's QuickJS dependency at the type
 * level. The runtime instance is created by the server and handed in.
 */
export interface SandboxedModulePack {
  readonly pluginId: string
  readonly modules: ReadonlyArray<{
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
    /** Package dependencies declared by the module — surfaced in the Dependencies Panel. */
    dependencies?: PluginModuleDependencies
    /** Optional iframe-backed editor preview source. */
    editorRuntime?: PluginEditorRuntime
  }>
  render(moduleId: string, props: Record<string, unknown>, children: string[]): { html: string; css?: string; js?: string }
  preview(moduleId: string, props: Record<string, unknown>, children: string[]): { html: string; css?: string; js?: string }
  dispose(): void
}

/**
 * Register every module in a sandboxed pack. Used by the server-side
 * lifecycle handler. Each module's render is a thunk that calls back into
 * the QuickJS VM — plugin render code never touches the host process.
 *
 * The browser path uses `activatePluginModulePack(manifest, mod, factory)`
 * which evaluates the pack in the browser's JS context. That isn't a
 * security boundary (XSS scope, not RCE), so no VM there.
 */
export function activateSandboxedPluginModulePack(
  manifest: PluginManifest,
  pack: SandboxedModulePack,
): void {
  assertPluginPermission(manifest, 'modules.register')

  // Replace any previous registrations for this plugin id atomically.
  deactivatePluginModulePack(manifest.id)
  const ids = new Set<string>()
  for (const meta of pack.modules) {
    // Synthesize a `PluginModuleDefinition` from the VM's metadata + a
    // render thunk that calls back into the sandbox. The host wrapper
    // (`pluginModuleToHostModule`) catches errors from the thunk.
    const definition: PluginModuleDefinition = {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      category: meta.category,
      version: meta.version,
      defaults: meta.defaults,
      // Schema shape from the SDK is `PluginPropertySchema` — already
      // serializable JSON, cast through `unknown` is safe.
      schema: meta.schema as unknown as PluginModuleDefinition['schema'],
      canHaveChildren: meta.canHaveChildren,
      htmlTag: meta.htmlTag,
      ...(meta.dependencies ? { dependencies: meta.dependencies } : {}),
      ...(meta.editorRuntime ? { editorRuntime: meta.editorRuntime } : {}),
      render: (props, children) => pack.render(meta.id, props, children),
      preview: meta.hasPreview
        ? (props, children) => pack.preview(meta.id, props, children)
        : undefined,
    }
    const hostModule = pluginModuleToHostModule(
      manifest.id,
      definition,
      STUB_COMPONENT_FACTORY,
      manifest.grantedPermissions ?? [],
    )
    registry.registerOrReplace(hostModule)
    ids.add(hostModule.id)
  }
  registeredByPlugin.set(manifest.id, ids)
  // Track the live VM so the next deactivate/reset disposes it (the
  // deactivate above already disposed any prior pack for this id).
  packsByPlugin.set(manifest.id, pack)
}
