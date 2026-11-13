/**
 * Dashboard widget registry — single in-memory map keyed by widget id.
 *
 * First-party widgets self-register at admin boot time (see
 * `src/admin/pages/dashboard/widgets/index.ts`). Plugins register additional
 * widgets via `api.dashboard.widgets.register(...)` (plugin SDK).
 *
 * Subscribe-style observers (`useSyncExternalStore`) are exposed for the
 * DashboardPage so newly-installed plugins surface their widgets without
 * requiring a page reload.
 *
 * Mirrors the shape of `pluginRuntime` in `src/core/plugins/runtime.ts` —
 * single mutable map, cached snapshot, listener bus, stable references
 * across reads so the React hook doesn't tear.
 */
import type { DashboardWidgetDefinition } from './types'

type Listener = () => void

class DashboardWidgetRegistry {
  private widgets = new Map<string, DashboardWidgetDefinition>()
  private listeners = new Set<Listener>()
  /**
   * `useSyncExternalStore` requires a stable snapshot reference between
   * mutations. We invalidate to `null` on any change and rebuild lazily
   * on the next `list()` call.
   */
  private snapshot: DashboardWidgetDefinition[] | null = null

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Register a widget. If a widget with the same id already exists it is
   * replaced (re-registration after plugin upgrade is normal). Returns the
   * disposer so first-party / plugin call sites can opt to unregister on
   * teardown — most callers just leak intentionally because the registry
   * lives for the page lifetime.
   */
  register(widget: DashboardWidgetDefinition): () => void {
    this.assertValid(widget)
    this.widgets.set(widget.id, widget)
    this.snapshot = null
    this.emit()
    return () => this.unregister(widget.id)
  }

  unregister(id: string): void {
    if (this.widgets.delete(id)) {
      this.snapshot = null
      this.emit()
    }
  }

  /**
   * Drop every widget owned by a specific plugin id. Called when a plugin
   * is disabled / uninstalled at runtime so its widgets vanish from the
   * grid without a page reload.
   */
  unregisterByOwner(ownerId: string): void {
    let changed = false
    for (const [id, w] of this.widgets) {
      if (w.ownerId === ownerId) {
        this.widgets.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.snapshot = null
      this.emit()
    }
  }

  /**
   * Drop every widget that is NOT a first-party (`ownerId === 'core'`)
   * registration. Used by `pluginRuntime.reset()` at the top of each
   * editor-plugin activation pass so a disabled-in-session plugin's
   * widgets disappear from the registry, rather than lingering from the
   * previous activation cycle. First-party widgets stay because they
   * re-register synchronously on dashboard mount via
   * `registerFirstPartyDashboardWidgets()` — wiping them here would
   * cause a brief flicker on every plugin lifecycle event.
   */
  unregisterAllPluginOwned(): void {
    let changed = false
    for (const [id, w] of this.widgets) {
      if (w.ownerId !== 'core') {
        this.widgets.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.snapshot = null
      this.emit()
    }
  }

  get(id: string): DashboardWidgetDefinition | undefined {
    return this.widgets.get(id)
  }

  /**
   * Stable-reference snapshot of all registered widgets. Safe to use as
   * the `getSnapshot` argument to `useSyncExternalStore`.
   */
  list(): readonly DashboardWidgetDefinition[] {
    if (this.snapshot === null) {
      this.snapshot = [...this.widgets.values()]
    }
    return this.snapshot
  }

  /**
   * Used by tests to start from a clean slate. Production code never
   * needs this — first-party widgets register at module import time and
   * stay for the page lifetime.
   */
  reset(): void {
    this.widgets.clear()
    this.snapshot = null
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private assertValid(widget: DashboardWidgetDefinition): void {
    if (typeof widget.id !== 'string' || widget.id.length === 0) {
      throw new Error('[dashboard] widget.id must be a non-empty string')
    }
    if (typeof widget.name !== 'string' || widget.name.length === 0) {
      throw new Error(`[dashboard] widget "${widget.id}" must have a name`)
    }
    if (widget.ownerId !== 'core') {
      // Plugin widgets must namespace under the plugin id.
      if (!widget.id.startsWith(`${widget.ownerId}.`)) {
        throw new Error(
          `[dashboard] plugin "${widget.ownerId}" cannot register widget "${widget.id}" — id must start with "${widget.ownerId}.".`,
        )
      }
      if (!widget.pluginContext) {
        throw new Error(
          `[dashboard] plugin widget "${widget.id}" must include its host context metadata.`,
        )
      }
    }
  }
}

/**
 * Process-wide singleton. There's exactly one dashboard grid per admin
 * session, so a single registry shared across hooks / SDK callers is the
 * right shape.
 */
export const dashboardWidgetRegistry = new DashboardWidgetRegistry()
