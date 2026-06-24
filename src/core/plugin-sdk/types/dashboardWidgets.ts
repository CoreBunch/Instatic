// ---------------------------------------------------------------------------
// Dashboard widgets — cards registered into the admin dashboard grid
// ---------------------------------------------------------------------------

/**
 * Tints reserved for dashboard widgets. Mirrors the four `--accent-*`
 * tokens in `src/styles/globals.css`. Widget chrome reads the value to
 * colour the title-dot and default chart accents.
 */
export type PluginDashboardWidgetTint = 'mint' | 'lilac' | 'sky' | 'peach'

/**
 * Default column span on the 12-column dashboard grid. Users can resize
 * a widget after dropping it via the customize-mode resize handle; this
 * is just the initial size.
 */
export type PluginDashboardWidgetSize = 3 | 4 | 6 | 8 | 12

export interface PluginDashboardWidgetRendererProps {
  /** Current grid span (1 .. 12). */
  span: number
  /** True while the user has the dashboard in "Customize" mode. */
  editing: boolean
}

/**
 * Dashboard widget registered by a plugin via
 * `api.dashboard.widgets.register(...)`. Requires the
 * `dashboard.widgets.register` permission.
 *
 *   • `id` MUST be namespaced under the plugin id (`<pluginId>.<rest>`),
 *     enforced by the registry at registration time.
 *   • `icon` is a pixel-art-icon component reference (direct import).
 *   • `component` is a regular React component. The host renders the
 *     widget chrome (title row, drag handle, kebab menu) and mounts the
 *     component inside the body — plugins only own the content.
 */
export interface PluginDashboardWidget {
  id: string
  name: string
  description: string
  iconName: string
  defaultSize: PluginDashboardWidgetSize
  tint: PluginDashboardWidgetTint
  component: import('react').ComponentType<PluginDashboardWidgetRendererProps>
}
