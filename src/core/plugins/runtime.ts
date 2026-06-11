import type { StoreApi } from 'zustand'
import type { EditorStore } from '@site/store/types'
import {
  createCmsPluginResourceRecord,
  deleteCmsPluginResourceRecord,
  listCmsPluginResourceRecords,
  updateCmsPluginResourceRecord,
} from '@core/persistence/cmsPluginRecords'

/**
 * Editor-store API injection. The plugin runtime only needs the editor
 * store when a granted plugin actually calls `api.store.read()` or
 * `api.store.transaction()` at runtime — but a static import of
 * `useEditorStore` from this file dragged the entire ~165 KB editor
 * store chunk into every consumer of `pluginRuntime` (Toolbar, spotlight,
 * plugin admin pages). Those consumers shouldn't pay that cost on first
 * paint.
 *
 * Instead, the editor store wires itself in at construction time via
 * `bindPluginRuntimeStoreApi(useEditorStore)` (see `src/admin/pages/site/
 * store/store.ts`). On non-editor admin pages where the editor store is
 * never loaded, the injection never fires — `api.store.*` then throws
 * when called, which is the correct behaviour (no editor → no editor
 * store).
 *
 * The plugin SDK is a public-looking contract today, but pre-release
 * stability lets us flip this to a different shape later if needed
 * without ceremony. Note for plugin authors: the `editor.store.*` API is
 * only valid inside the editor canvas (Site / Content / Data / Media
 * pages).
 */
let editorStoreApi: StoreApi<EditorStore> | null = null

/**
 * Wire the editor store into the plugin runtime so granted plugins can call
 * `api.store.read()` / `api.store.transaction()`. The runtime intentionally
 * does NOT statically import the editor store (that would drag it into the
 * admin-shell bundle); this binder fills the slot once `useEditorStore` is
 * constructed in `src/admin/pages/site/store/store.ts`.
 *
 * The name distinguishes this from the settings-bridge binder in
 * `settingsSlice.ts` — both used to be exported as `bindEditorStoreApi`
 * and required call-site aliases to disambiguate.
 */
export function bindPluginRuntimeStoreApi(api: StoreApi<unknown>): void {
  editorStoreApi = api as StoreApi<EditorStore>
}

function requireEditorStore(): StoreApi<EditorStore> {
  if (!editorStoreApi) {
    throw new Error(
      '[plugin-runtime] editor store accessed before initialization. ' +
      'This typically means a plugin called api.store.read/transaction ' +
      'outside an editor route (Site / Content / Data / Media), where ' +
      'the editor store has not been loaded.',
    )
  }
  return editorStoreApi
}
import type {
  EditorPluginApi,
  EditorPluginModule,
  PluginCanvasOverlay,
  PluginCommand,
  PluginCommandResult,
  PluginDashboardWidget,
  PluginEditorPanel,
  PluginManifest,
  PluginPaletteProvider,
  PluginToolbarButton,
  RegisteredPluginCanvasOverlay,
  RegisteredPluginEditorPanel,
  RegisteredPluginToolbarButton,
} from '@core/plugin-sdk'
import { assertPluginPermission } from '@core/plugin-sdk'
import { dashboardWidgetRegistry } from '@core/dashboard'

/**
 * Icon-name → component resolver injected by the admin shell at boot.
 *
 * The dashboard registry stores real React icon components (so the
 * DashboardPage can render them directly), but plugins declare their
 * widget icons by string name across the SDK boundary. We need a
 * lookup table here to bridge the two — but that table lives in the
 * admin layer (it imports real `pixel-art-icons/icons/<name>` modules)
 * and `@core/plugins/runtime` must not pull admin code into its graph.
 *
 * Instead, the admin shell calls `bindDashboardWidgetIconResolver(...)`
 * once at boot to inject the resolver. If a plugin registers a widget
 * before the resolver is bound (only possible from the server side, which
 * doesn't load this runtime), or if no resolver is bound, the widget
 * registration is rejected loudly rather than silently rendering a
 * placeholder.
 */
type IconResolver = (iconName: string) => import('@core/dashboard').PixelArtIconComponent

let dashboardIconResolver: IconResolver | null = null

export function bindDashboardWidgetIconResolver(resolver: IconResolver): void {
  dashboardIconResolver = resolver
}

function requireDashboardIconResolver(): IconResolver {
  if (!dashboardIconResolver) {
    throw new Error(
      '[plugin-runtime] dashboard widget icon resolver not bound. The admin shell must call bindDashboardWidgetIconResolver() at boot before any plugin registers a dashboard widget.',
    )
  }
  return dashboardIconResolver
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type RuntimeListener = () => void

/**
 * Internal panel record — keeps the live manifest alongside the panel so
 * the host's `PluginEditorPanelMount` can build an api with the right
 * permission grants without a fresh round-trip to the plugins endpoint.
 */
interface PanelRecord {
  panel: RegisteredPluginEditorPanel
  manifest: PluginManifest
}

/** Palette provider stored alongside the registering plugin id. */
type RegisteredPaletteProvider = PluginPaletteProvider & { pluginId: string }

/**
 * Internal canvas-overlay record — same shape rationale as `PanelRecord`:
 * the live manifest rides along so the host's overlay mount can build a
 * permission-aware `PluginContext` (granted permissions, settings) without
 * a fresh round-trip to the plugins endpoint.
 */
interface CanvasOverlayRecord {
  overlay: RegisteredPluginCanvasOverlay
  manifest: PluginManifest
}

class PluginRuntime {
  private commands = new Map<string, PluginCommand & { pluginId: string }>()
  private toolbarButtons = new Map<string, RegisteredPluginToolbarButton>()
  private panels = new Map<string, PanelRecord>()
  private canvasOverlays = new Map<string, CanvasOverlayRecord>()
  private paletteProviders = new Map<string, RegisteredPaletteProvider>()
  private pluginSettings = new Map<string, Record<string, string | number | boolean>>()
  private pluginNames = new Map<string, string>()
  private listeners = new Set<RuntimeListener>()

  /**
   * Cached snapshots — `useSyncExternalStore` requires `getSnapshot()` to
   * return a referentially stable value when nothing has changed, otherwise
   * React tears the subscriber on every render and triggers an infinite
   * loop. We invalidate (set to null) on every mutation and rebuild lazily
   * the next time a getter is called.
   */
  private toolbarButtonsSnapshot: RegisteredPluginToolbarButton[] | null = null
  private panelsSnapshot: RegisteredPluginEditorPanel[] | null = null
  private canvasOverlaysSnapshot: RegisteredPluginCanvasOverlay[] | null = null

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reset(): void {
    this.commands.clear()
    this.toolbarButtons.clear()
    this.panels.clear()
    this.canvasOverlays.clear()
    this.paletteProviders.clear()
    this.pluginSettings.clear()
    this.pluginNames.clear()
    this.toolbarButtonsSnapshot = null
    this.panelsSnapshot = null
    this.canvasOverlaysSnapshot = null
    // Dashboard widgets are stored in a separate registry (the host's
    // admin shell consumes `dashboardWidgetRegistry` directly via
    // `useSyncExternalStore`). Clear plugin-owned entries here so a
    // disabled-in-session plugin's widgets disappear on the next
    // activation pass instead of lingering from the previous cycle.
    // First-party widgets are left in place — they re-register
    // synchronously when the DashboardPage mounts, and wiping them
    // would briefly flicker every Visitors/Storage tile on every plugin
    // lifecycle event.
    dashboardWidgetRegistry.unregisterAllPluginOwned()
    this.emit()
  }

  /**
   * Deactivate all registrations for a single plugin — commands, toolbar
   * buttons, panels, canvas overlays, palette providers, and dashboard
   * widgets. Called when a plugin is disabled or uninstalled at runtime
   * without a full reload.
   *
   * The common case (editor page reload) still goes through `reset()` which
   * clears all registrations at once. This method handles the incremental
   * case (e.g. admin disabling a plugin from the Plugins page).
   */
  deactivatePlugin(pluginId: string): void {
    for (const [key, cmd] of this.commands) {
      if (cmd.pluginId === pluginId) this.commands.delete(key)
    }
    for (const [key, btn] of this.toolbarButtons) {
      if (btn.pluginId === pluginId) this.toolbarButtons.delete(key)
    }
    for (const [key, record] of this.panels) {
      if (record.panel.pluginId === pluginId) this.panels.delete(key)
    }
    for (const [key, record] of this.canvasOverlays) {
      if (record.overlay.pluginId === pluginId) this.canvasOverlays.delete(key)
    }
    for (const [key, provider] of this.paletteProviders) {
      if (provider.pluginId === pluginId) this.paletteProviders.delete(key)
    }
    dashboardWidgetRegistry.unregisterByOwner(pluginId)
    this.toolbarButtonsSnapshot = null
    this.panelsSnapshot = null
    this.canvasOverlaysSnapshot = null
    this.emit()
  }

  /**
   * Cache the live settings snapshot for a plugin so panel api factories
   * can hand it to the plugin's render code without a per-mount round-trip.
   * Refreshed by `activateInstalledEditorPlugins` on every editor reload
   * and by the Plugins admin page after a settings PUT. The snapshot comes
   * from the admin HTTP payload, where secret values are masked (`'***'`)
   * — editor-side plugin code never sees real secrets.
   */
  setPluginSettings(pluginId: string, settings: Record<string, string | number | boolean>): void {
    this.pluginSettings.set(pluginId, { ...settings })
  }

  getPluginSettings(pluginId: string): Record<string, string | number | boolean> {
    return { ...(this.pluginSettings.get(pluginId) ?? {}) }
  }

  /**
   * Cache an installed plugin's display name so editor UI (e.g. the module
   * inserter's per-plugin layout groups) can label plugin-owned content
   * synchronously. Set for every installed plugin — enabled or not — by
   * `activateInstalledEditorPlugins`.
   */
  setPluginName(pluginId: string, name: string): void {
    this.pluginNames.set(pluginId, name)
  }

  getPluginName(pluginId: string): string | null {
    return this.pluginNames.get(pluginId) ?? null
  }

  registerCommand(pluginId: string, command: PluginCommand): void {
    this.commands.set(command.id, { ...command, pluginId })
    this.emit()
  }

  /**
   * Register a Command Spotlight live-search provider on behalf of a plugin.
   * The provider id MUST be namespaced under the plugin id (`<pluginId>.<name>`).
   * Caller is responsible for asserting the `editor.commands` permission before
   * invoking this method.
   */
  registerPaletteProvider(pluginId: string, provider: PluginPaletteProvider): void {
    if (!provider.id.startsWith(`${pluginId}.`)) {
      console.error(
        `[plugin:${pluginId}] Palette provider id "${provider.id}" must start with "${pluginId}." — registration skipped.`,
      )
      return
    }
    this.paletteProviders.set(provider.id, { ...provider, pluginId })
    this.emit()
  }

  /**
   * Returns all registered plugin commands with their owning plugin id.
   * The spotlight palette calls this on each open to synthesize the
   * 'plugins' group of the command registry.
   */
  getPluginCommands(): ReadonlyArray<PluginCommand & { pluginId: string }> {
    return [...this.commands.values()]
  }

  /**
   * Returns all registered palette providers with their owning plugin id.
   * The spotlight wraps each in a `SpotlightProvider` at search time.
   */
  getPaletteProviders(): ReadonlyArray<RegisteredPaletteProvider> {
    return [...this.paletteProviders.values()]
  }

  registerToolbarButton(pluginId: string, button: PluginToolbarButton): void {
    this.toolbarButtons.set(button.id, { ...button, pluginId })
    this.toolbarButtonsSnapshot = null
    this.emit()
  }

  /**
   * Register a dashboard widget on behalf of a plugin. Caller MUST have
   * already asserted the `dashboard.widgets.register` permission. The
   * widget id must be namespace-locked under the plugin id
   * (`<pluginId>.<rest>`) — enforced by the registry, not here.
   *
   * Plugin-side iconName strings are resolved through the bound
   * `IconResolver` (`bindDashboardWidgetIconResolver`) — if no resolver
   * has been bound by the host, the registration throws loudly.
   */
  registerDashboardWidget(pluginId: string, widget: PluginDashboardWidget): void {
    const iconResolve = requireDashboardIconResolver()
    dashboardWidgetRegistry.register({
      id: widget.id,
      ownerId: pluginId,
      name: widget.name,
      description: widget.description,
      icon: iconResolve(widget.iconName),
      defaultSize: widget.defaultSize,
      tint: widget.tint,
      render: widget.component,
    })
  }

  /**
   * Register an editor panel on behalf of a plugin. Caller MUST have already
   * asserted the `editor.panels` permission. The panel id must be
   * namespace-locked under the plugin id (`<pluginId>.<rest>`).
   *
   * The manifest is captured alongside the panel so the host can build a
   * permission-aware api when mounting the panel later, without a fresh
   * round-trip to the plugins endpoint.
   */
  registerPanel(manifest: PluginManifest, panel: PluginEditorPanel): void {
    if (!panel.id.startsWith(`${manifest.id}.`)) {
      throw new Error(
        `Plugin "${manifest.id}" cannot register panel "${panel.id}" — id must start with "${manifest.id}.".`,
      )
    }
    this.panels.set(panel.id, {
      panel: { ...panel, pluginId: manifest.id },
      manifest,
    })
    this.panelsSnapshot = null
    this.emit()
  }

  /**
   * Register a canvas overlay on behalf of a plugin. Caller MUST have
   * already asserted the `editor.canvas` permission. The overlay id must
   * be namespace-locked under the plugin id (`<pluginId>.<rest>`).
   *
   * The manifest is captured alongside the overlay (same as `registerPanel`)
   * so the host's overlay mount can provide a permission-aware
   * `PluginContext` to the overlay component.
   */
  registerCanvasOverlay(manifest: PluginManifest, overlay: PluginCanvasOverlay): void {
    if (!overlay.id.startsWith(`${manifest.id}.`)) {
      throw new Error(
        `Plugin "${manifest.id}" cannot register canvas overlay "${overlay.id}" — id must start with "${manifest.id}.".`,
      )
    }
    this.canvasOverlays.set(overlay.id, {
      overlay: { ...overlay, pluginId: manifest.id },
      manifest,
    })
    this.canvasOverlaysSnapshot = null
    this.emit()
  }

  /**
   * Returns the cached toolbar-button array. Stable reference across calls
   * until a `register*` / `reset()` mutation invalidates the cache. Required
   * for `useSyncExternalStore` consumers (PanelRail, Toolbar).
   */
  getToolbarButtons(): RegisteredPluginToolbarButton[] {
    if (this.toolbarButtonsSnapshot === null) {
      this.toolbarButtonsSnapshot = [...this.toolbarButtons.values()]
    }
    return this.toolbarButtonsSnapshot
  }

  /**
   * Returns the cached panels array. Stable reference across calls until a
   * `registerPanel` / `reset()` mutation invalidates the cache. PanelRail
   * subscribes via `useSyncExternalStore` — a fresh array on every getter
   * call would tear the subscriber and trigger an infinite re-render loop.
   */
  getPanels(): RegisteredPluginEditorPanel[] {
    if (this.panelsSnapshot === null) {
      this.panelsSnapshot = [...this.panels.values()].map((record) => record.panel)
    }
    return this.panelsSnapshot
  }

  getPanel(panelId: string): RegisteredPluginEditorPanel | undefined {
    return this.panels.get(panelId)?.panel
  }

  /**
   * Resolve the manifest a panel was registered with — used by
   * `PluginEditorPanelMount` to build a permission-checked api at render
   * time. Returns `undefined` for unknown panel ids.
   */
  getPanelManifest(panelId: string): PluginManifest | undefined {
    return this.panels.get(panelId)?.manifest
  }

  /**
   * Returns the cached canvas overlays array. Stable reference until a
   * mutation invalidates the cache — same `useSyncExternalStore` shape as
   * `getPanels()` / `getToolbarButtons()`.
   */
  getCanvasOverlays(): RegisteredPluginCanvasOverlay[] {
    if (this.canvasOverlaysSnapshot === null) {
      this.canvasOverlaysSnapshot = [...this.canvasOverlays.values()].map((record) => record.overlay)
    }
    return this.canvasOverlaysSnapshot
  }

  /**
   * Resolve the manifest a canvas overlay was registered with — used by
   * `PluginCanvasOverlayLayer` to provide a permission-aware
   * `PluginContext` at mount time. Returns `undefined` for unknown ids.
   */
  getCanvasOverlayManifest(overlayId: string): PluginManifest | undefined {
    return this.canvasOverlays.get(overlayId)?.manifest
  }

  async runCommand(commandId: string): Promise<PluginCommandResult> {
    const command = this.commands.get(commandId)
    if (!command) throw new Error(`Plugin command "${commandId}" is not registered`)
    return await command.run()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const pluginRuntime = new PluginRuntime()

/**
 * Build the editor-side plugin API object for a given manifest.
 * Exported so tests can construct the API directly without a full plugin
 * activation cycle. Production callers go through `activateEditorPlugin`.
 */
export function createEditorPluginApi(
  manifest: PluginManifest,
  fetchImpl: FetchLike,
): EditorPluginApi {
  const baseAsset = (manifest.assetBasePath ?? `/uploads/plugins/${manifest.id}/${manifest.version}`)
    .replace(/\/+$/g, '')
  return {
    plugin: {
      id: manifest.id,
      version: manifest.version,
      permissions: [...(manifest.grantedPermissions ?? [])],
      assetUrl(path) {
        if (typeof path !== 'string' || path.length === 0) {
          throw new TypeError('assetUrl: path must be a non-empty string')
        }
        const rel = path.replace(/^\/+/g, '')
        return `${baseAsset}/${rel}`
      },
    },
    editor: {
      commands: {
        register(command) {
          assertPluginPermission(manifest, 'editor.commands')
          pluginRuntime.registerCommand(manifest.id, command)
        },
      },
      toolbar: {
        addButton(button) {
          assertPluginPermission(manifest, 'editor.toolbar')
          pluginRuntime.registerToolbarButton(manifest.id, button)
        },
      },
      panels: {
        register(panel) {
          assertPluginPermission(manifest, 'editor.panels')
          pluginRuntime.registerPanel(manifest, panel)
        },
      },
      canvas: {
        registerOverlay(overlay) {
          assertPluginPermission(manifest, 'editor.canvas')
          pluginRuntime.registerCanvasOverlay(manifest, overlay)
        },
      },
      store: {
        read() {
          assertPluginPermission(manifest, 'editor.store.read')
          return requireEditorStore().getState()
        },
        transaction(mutate) {
          // `editor.store.write` is a deliberately BROAD grant: it hands the
          // plugin a mutable draft of the ENTIRE editor store, so any approved
          // plugin can mutate any editor state inside the transaction. This
          // coarse scope is an intentional choice — the editor store has no
          // sub-resource permission model, and a finer-grained surface would
          // be security theatre over a store the plugin can already read in
          // full via `editor.store.read`. Operators gate the capability at
          // install time; that single grant is the trust boundary.
          assertPluginPermission(manifest, 'editor.store.write')
          // The underlying editor store is created with the mutative middleware
          // (see `useEditorStore` in `@site/store/store`), so `setState`
          // accepts a void-returning mutator that mutates the draft in place.
          // The bare `StoreApi<EditorStore>` type can't see the mutative-augmented
          // signature, hence the cast — runtime behavior is fully covered by
          // mutative's `create`.
          const setState = requireEditorStore().setState as (
            updater: (state: EditorStore) => void,
          ) => void
          setState((state) => {
            mutate(state)
          })
        },
      },
      palette: {
        registerCommand(cmd) {
          const granted = (manifest.grantedPermissions ?? []).includes('editor.commands')
          if (!granted) {
            console.warn(
              `[plugin:${manifest.id}] palette.registerCommand requires the "editor.commands" permission — registration skipped.`,
            )
            return
          }
          pluginRuntime.registerCommand(manifest.id, cmd)
        },
        registerProvider(provider) {
          const granted = (manifest.grantedPermissions ?? []).includes('editor.commands')
          if (!granted) {
            console.warn(
              `[plugin:${manifest.id}] palette.registerProvider requires the "editor.commands" permission — registration skipped.`,
            )
            return
          }
          pluginRuntime.registerPaletteProvider(manifest.id, provider)
        },
      },
    },
    dashboard: {
      widgets: {
        register(widget) {
          assertPluginPermission(manifest, 'dashboard.widgets.register')
          pluginRuntime.registerDashboardWidget(manifest.id, widget)
        },
      },
    },
    cms: {
      storage: {
        collection(resourceId) {
          assertPluginPermission(manifest, 'cms.storage')
          return {
            list: (options) => listCmsPluginResourceRecords(manifest.id, resourceId, fetchImpl, '/admin/api/cms', options),
            create: (data) => createCmsPluginResourceRecord(manifest.id, resourceId, data, fetchImpl),
            update: (recordId, data) => updateCmsPluginResourceRecord(manifest.id, resourceId, recordId, data, fetchImpl),
            delete: (recordId) => deleteCmsPluginResourceRecord(manifest.id, resourceId, recordId, fetchImpl),
          }
        },
      },
    },
  }
}

export async function activateEditorPlugin(
  manifest: PluginManifest,
  mod: EditorPluginModule,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<void> {
  const api = createEditorPluginApi(manifest, fetchImpl)
  await mod.activate(api)
}
