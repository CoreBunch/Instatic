import type { PluginAdminPage } from './adminPages'
import type { PluginLifecycleStatus } from './lifecycle'
import type { PluginManifest } from './manifest'
import type { PluginPermission } from './permissions'

// ---------------------------------------------------------------------------
// Installed plugin — manifest + host bookkeeping
// ---------------------------------------------------------------------------

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  enabled: boolean
  lifecycleStatus: PluginLifecycleStatus
  lastError: string | null
  grantedPermissions: PluginPermission[]
  manifest: PluginManifest
  /**
   * Current user-edited settings values, keyed by setting id. Always
   * contains every setting declared in `manifest.settings` — defaults
   * are populated on install. Secret values are masked (`'***'`) on every
   * payload the host sends to the browser — list, install/upgrade/state
   * responses, admin-page snapshots, and editor-panel snapshots — so
   * editor-side and admin-app plugin code never sees the real value. Only
   * server-side plugin code reading via `api.cms.settings.get` does.
   */
  settings: Record<string, string | number | boolean>
  installedAt: string
  updatedAt: string
  /**
   * Recent worker-crash events for this plugin (newest first, capped to 10
   * by the host). Only attached when the row is read through the admin
   * `pluginsPayload` helper — internal repository reads return an empty
   * array. Surfaced in the admin UI's "Recent issues" panel so site owners
   * can see why a plugin is in `error` state without tailing server logs.
   */
  recentCrashes?: Array<{
    id: string
    pluginId: string
    occurredAt: string
    reason: string
    stack: string | null
  }>
}

// ---------------------------------------------------------------------------
// Admin page route — host-decorated admin page registered by the manifest
// ---------------------------------------------------------------------------

export interface PluginAdminPageRoute extends Omit<PluginAdminPage, 'route'> {
  pluginId: string
  pluginName: string
  /** Plugin manifest version — surfaced to plugin code via `usePluginContext()`. */
  pluginVersion: string
  /**
   * Row-level timestamp from the plugin install. Used by the host as a
   * cache-buster suffix for the plugin's admin app entrypoint URL — the
   * browser caches stably across editor visits but refetches on upgrade
   * or re-install.
   */
  pluginUpdatedAt: string
  /** Always populated by the host's manifest parser. */
  route: string
  /**
   * Snapshot of the plugin's persisted settings at the moment the host
   * rendered the page. Plugin admin apps read via the `usePluginSettings`
   * hook which returns this snapshot synchronously. Secret values are
   * masked (`'***'`) — admin-app code never sees real secrets.
   */
  pluginSettings: Record<string, string | number | boolean>
  /** The full settings schema declared by the plugin manifest. */
  pluginSettingsSchema: PluginManifest['settings']
  /**
   * Permissions the operator granted to the plugin at install time. The
   * host's admin-app loader refuses to dynamically import an app page
   * without `editor.code` here, and plugin-surface hooks
   * (`useEditorStore`, …) enforce their grants against this set via
   * `PluginContext`.
   */
  pluginGrantedPermissions: PluginPermission[]
}

// ---------------------------------------------------------------------------
// Admin payload — sent to the admin shell to render the Plugins workspace
// ---------------------------------------------------------------------------

export interface CmsPluginsPayload {
  plugins: InstalledPlugin[]
  adminPages: PluginAdminPageRoute[]
}
