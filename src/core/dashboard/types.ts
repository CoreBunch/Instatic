/**
 * Dashboard widget types.
 *
 * The admin dashboard (`/admin/dashboard`) renders a configurable grid of
 * widgets. First-party widgets (Visitors, Pages, Storage, …) are registered
 * during admin bootstrap; plugins register their own widgets via
 * `api.dashboard.widgets.register(...)` exposed through the plugin SDK.
 *
 * A widget is a React component plus a small set of metadata (id, name,
 * description, icon, default size, tint, owner plugin id). The grid is a
 * 12-column layout; widgets declare their default column span via `size`.
 *
 * Plugin widget IDs MUST be prefixed with the plugin id (`<pluginId>.<key>`).
 * First-party widgets use plain keys (`visitors`, `pages`, etc.) and live
 * under the implicit `core` namespace.
 */
import type { ComponentType } from 'react'
import type { PixelArtIconComponent } from './iconLookup'

/**
 * Default grid sizes a widget can declare. Every dashboard grid is 12 cols.
 * Custom spans (1 .. 12) work fine, but the canonical set keeps designs
 * consistent and the resize handles snap-friendly.
 */
type DashboardWidgetSize = 3 | 4 | 6 | 8 | 12

/**
 * Tints from `src/styles/globals.css`. Widget chrome reads `--tint` from this
 * value to color the title dot and chart accents — see `Widget.tsx`. Plugins
 * pick one of these tokens so the dashboard stays visually coherent.
 */
type DashboardWidgetTint = 'mint' | 'lilac' | 'sky' | 'peach'

export interface DashboardWidgetRendererProps {
  /**
   * The current grid span (1 .. 12). The widget body is responsible for
   * scaling content to its assigned column width — most widgets use CSS
   * grid and don't need to read it, but charts that compute pixel widths
   * may.
   */
  span: number
  /** True when the user has the dashboard in "Customize" mode. */
  editing: boolean
}

export interface DashboardWidgetDefinition {
  /**
   * Stable identifier. First-party widgets use plain keys (`visitors`).
   * Plugin-registered widgets MUST namespace under the plugin id
   * (`acme.analytics.pageviews`). The registry rejects non-namespaced
   * registrations from a plugin source at runtime.
   */
  id: string
  /** Owner plugin id, or `'core'` for first-party widgets. */
  ownerId: string
  /** Display name in the block picker and widget chrome. */
  name: string
  /** Short description shown beneath the name in the block picker. */
  description: string
  /**
   * Pixel-art icon component, e.g. `EyeSolidIcon`. Renders at size 11 in
   * the widget title row and at size 14 in the block picker. Must be a
   * direct icon import (`from 'pixel-art-icons/icons/<name>'`), never a
   * lazy Icon-wrapper component.
   */
  icon: PixelArtIconComponent
  /** Default column span when the widget is first added to the grid. */
  defaultSize: DashboardWidgetSize
  /**
   * Accent tint used for the widget title-dot and any default chart
   * fills. Plugin widgets pick one of the four to stay on-palette.
   */
  tint: DashboardWidgetTint
  /**
   * Renderer. Receives the live span (so charts can rescale) and an
   * `editing` flag (so widgets can hide interactive UI while the user
   * is rearranging the grid). The widget chrome (title, drag handle,
   * kebab menu) is provided by the host — the renderer only owns the
   * content body.
   */
  render: ComponentType<DashboardWidgetRendererProps>
}
