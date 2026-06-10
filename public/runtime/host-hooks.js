// fallow-ignore-file unused-file
// Loaded at runtime by plugin bundles via the import map in index.html.
// Fallow cannot see this static-asset path; the file is live in production.
/**
 * Plugin-runtime shim for `@instatic/host-hooks`.
 *
 * Plugins import editor + plugin-runtime hooks from this package:
 *   useEditorStore, usePluginSettings, usePluginContext,
 *   usePluginRoutes, useEditorCommand
 *
 * The host's main bundle populates `globalThis.__instatic.hostHooks`
 * with the live hook implementations and the React context they
 * subscribe to.
 *
 * Permission-gated hooks enforce the operator's grants per mounted
 * plugin surface: `useEditorStore` throws without `editor.store.read`.
 * No write-capable store accessor is exposed here — editor-store
 * mutations go through `api.editor.store.transaction`
 * (`editor.store.write`) in the plugin's editor entrypoint.
 */
const G = globalThis.__instatic?.hostHooks
if (!G) {
  throw new Error(
    "[@instatic/runtime] Host hooks not initialized. Did the host bundle finish loading before the plugin import?",
  )
}

export const PluginContext = G.PluginContext
export const useEditorStore = G.useEditorStore
export const usePluginSettings = G.usePluginSettings
export const usePluginContext = G.usePluginContext
export const usePluginRoutes = G.usePluginRoutes
export const useEditorCommand = G.useEditorCommand
export const useCanvasNodeRect = G.useCanvasNodeRect
export const useCanvasViewport = G.useCanvasViewport
