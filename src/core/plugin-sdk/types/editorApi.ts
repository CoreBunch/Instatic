import type { EditorStore } from '@site/store/types'
import type {
  PluginRecord,
  StorageListOptions,
  StorageListResult,
} from '../storageSchemas'
import type { PluginCanvasOverlay } from './canvasOverlays'
import type { PluginCommand, PluginPaletteProvider, PluginToolbarButton } from './commands'
import type { PluginDashboardWidget } from './dashboardWidgets'
import type { EditorFragmentsApi } from './fragments'
import type { PluginEditorPanel } from './panels'
import type { PluginPermission } from './permissions'

// ---------------------------------------------------------------------------
// EditorPluginApi — the API surface available to editor entrypoints
// ---------------------------------------------------------------------------

export interface EditorPluginApi {
  /**
   * Plugin metadata available to editor entrypoints. Mirrors the shape of
   * `ServerPluginApi.plugin` for consistency, minus `log` (editor code can
   * use the browser console directly).
   */
  plugin: {
    id: string
    version: string
    permissions: PluginPermission[]
    /**
     * Build a URL for a static file the plugin shipped in its zip. See
     * `ServerPluginApi.plugin.assetUrl` for semantics — both forms return
     * the same `/uploads/plugins/<id>/<version>/<path>` URL.
     */
    assetUrl: (path: string) => string
  }
  editor: {
    commands: {
      register: (command: PluginCommand) => void
    }
    toolbar: {
      addButton: (button: PluginToolbarButton) => void
    }
    panels: {
      /**
       * Register a left-sidebar panel that the user can open from the rail.
       * Requires the `editor.panels` permission. The panel id MUST start
       * with `<pluginId>.` — the runtime enforces the namespace at
       * registration time.
       */
      register: (panel: PluginEditorPanel) => void
    }
    canvas: {
      /**
       * Register a canvas overlay React component that mounts on top of
       * the rendered canvas. Requires the `editor.canvas` permission.
       * Overlay id MUST start with `<pluginId>.` — namespace-locked at
       * registration time.
       */
      registerOverlay: (overlay: PluginCanvasOverlay) => void
    }
    store: {
      read: () => EditorStore
      transaction: (mutate: (store: EditorStore) => void) => void
    }
    /**
     * Insert site fragments into the open document, or plan one as a dry
     * run. Requires the `editor.fragments` permission. Works while the site
     * editor has a document open; elsewhere `insert` resolves
     * `{ ok: false, stage: 'unavailable' }` and `plan` `{ ok: false }`.
     */
    fragments: EditorFragmentsApi
    /**
     * Command Spotlight (⌘K) integration.
     *
     * Both methods require the `editor.commands` permission.
     * If the permission is not granted, the call is a no-op and a warning
     * is logged — no exception is thrown.
     *
     * All commands registered via `editor.commands.register` are ALSO
     * auto-surfaced in the palette (§6.1 of the spotlight plan), so
     * `palette.registerCommand` is only needed when you want to register a
     * palette-only command that is NOT a toolbar-reachable command.
     */
    palette: {
      /**
       * Register a command in the Command Spotlight palette.
       * Equivalent to `editor.commands.register` but makes intent explicit
       * for commands authored specifically for the palette (with subtitle,
       * iconName, args, etc.).
       */
      registerCommand: (cmd: PluginCommand) => void
      /**
       * Register a live-search provider. The palette calls `provider.search`
       * on each debounced keystroke and groups results under `provider.label`.
       */
      registerProvider: (provider: PluginPaletteProvider) => void
    }
  }
  /**
   * Admin dashboard surface — `/admin/dashboard`. Plugins register cards
   * (analytics charts, queue counters, plugin-specific stats) for the
   * configurable widget grid via `dashboard.widgets.register(...)`.
   * Requires the `dashboard.widgets.register` permission.
   */
  dashboard: {
    widgets: {
      /**
       * Register a dashboard widget. The widget id MUST be namespaced
       * under the plugin id (`<pluginId>.<rest>`) — registration is
       * rejected otherwise. Re-registration with the same id replaces
       * the previous definition (normal on plugin upgrade).
       */
      register: (widget: PluginDashboardWidget) => void
    }
  }
  cms: {
    storage: {
      collection: (resourceId: string) => {
        list: (options?: StorageListOptions) => Promise<StorageListResult>
        create: (data: Record<string, unknown>) => Promise<PluginRecord>
        update: (recordId: string, data: Record<string, unknown>) => Promise<PluginRecord>
        delete: (recordId: string) => Promise<void>
      }
    }
  }
}

export interface EditorPluginModule {
  activate: (api: EditorPluginApi) => void | Promise<void>
}
