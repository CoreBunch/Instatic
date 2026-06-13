/**
 * Server-side plugin hook bus.
 *
 * Centralised registry for plugin event listeners (`on`) and filter handlers
 * (`filter`). Lives in `src/core/` because the runtime types are shared with
 * the SDK and tests, but only the server activates plugin server modules so
 * in practice this singleton runs only inside the Bun server process.
 *
 * Two pipelines:
 *   • `on(event, listener)` — listeners receive a payload, return value is
 *     ignored. Listeners run sequentially in registration order; an
 *     unhandled error in one listener does not stop the others (it's logged
 *     with `[plugin:<id>]`).
 *   • `filter(name, handler)` — handlers transform a value. Each handler
 *     receives the latest value (after previous handlers ran) and must
 *     return one of the same type. Errors fall back to the previous value
 *     and are logged.
 *
 * Plugin registration is keyed by plugin id so `unregisterPlugin(pluginId)`
 * cleanly tears everything down on disable/uninstall.
 *
 * Event-name provenance: only the HOST emits the reserved core events in
 * `CORE_HOOK_EVENTS`. Plugin-emitted events (via `cms.hooks.emit`) are
 * force-namespaced to `plugin.<pluginId>.<name>` through
 * `canonicalPluginEventName` before they reach `emit`, so a plugin can never
 * forge a core event or impersonate another plugin. `emit` is typed against
 * exactly those two name spaces — a new host emit site cannot introduce a
 * core event without adding it to `CORE_HOOK_EVENTS` first.
 */

/**
 * Reserved host-emitted event names — the single source of truth. Plugins can
 * LISTEN to these freely, but cannot emit them: plugin emits are always
 * canonicalized into the `plugin.<pluginId>.*` namespace.
 */
type CoreHookEvent =
  | 'settings.changed'
  | 'content.entry.created'
  | 'content.entry.updated'
  | 'content.entry.deleted'
  | 'publish.before'
  | 'publish.after'

/** A plugin-emitted event name, always of the form `plugin.<pluginId>.<name>`. */
type PluginScopedHookEvent = `plugin.${string}`

/**
 * Canonical name for a plugin-emitted hook event.
 *
 * Rules (one coherent contract — auto-prefix, never spoof):
 *   • already in the plugin's own namespace (`plugin.<pluginId>.…`) — returned
 *     unchanged (no double prefix)
 *   • in the `plugin.*` namespace but NOT the plugin's own — thrown as an
 *     impersonation attempt
 *   • any other name (including reserved core names) — prefixed with
 *     `plugin.<pluginId>.`, so e.g. a raw emit of `content.entry.created`
 *     becomes the harmless `plugin.<pluginId>.content.entry.created`
 *
 * `pluginId` must be the host-verified worker identity (validated in
 * `workerPool`), never a plugin-supplied value.
 */
export function canonicalPluginEventName(pluginId: string, event: string): PluginScopedHookEvent {
  const ownNamespace = `plugin.${pluginId}.` as const
  if (event.startsWith(ownNamespace)) {
    // startsWith doesn't narrow string → template-literal type; the prefix
    // check above is exactly the PluginScopedHookEvent shape.
    return event as PluginScopedHookEvent
  }
  if (event.startsWith('plugin.')) {
    throw new Error(
      `Plugin "${pluginId}" cannot emit "${event}": the plugin.* event namespace is reserved per plugin. ` +
        `Emit "${ownNamespace}<name>" or a bare name, which is namespaced to "${ownNamespace}<name>" automatically.`,
    )
  }
  return `${ownNamespace}${event}`
}

type HookListener = (payload: unknown) => void | Promise<void>
type HookFilterHandler = (
  value: unknown,
  context: { pluginId: string },
) => unknown | Promise<unknown>

interface RegisteredListener {
  pluginId: string
  listener: HookListener
}

interface RegisteredFilter {
  pluginId: string
  handler: HookFilterHandler
}

class HookBus {
  private listeners = new Map<string, RegisteredListener[]>()
  private filters = new Map<string, RegisteredFilter[]>()

  reset(): void {
    this.listeners.clear()
    this.filters.clear()
  }

  on(pluginId: string, event: string, listener: HookListener): void {
    const entries = this.listeners.get(event) ?? []
    entries.push({ pluginId, listener })
    this.listeners.set(event, entries)
  }

  filter(pluginId: string, name: string, handler: HookFilterHandler): void {
    const entries = this.filters.get(name) ?? []
    entries.push({ pluginId, handler })
    this.filters.set(name, entries)
  }

  /**
   * Tear down every listener and filter registered by a given plugin id.
   * Called on plugin disable / uninstall and on `activateInstalledServerPlugins`
   * before re-binding.
   */
  unregisterPlugin(pluginId: string): void {
    for (const [event, entries] of this.listeners) {
      const remaining = entries.filter((entry) => entry.pluginId !== pluginId)
      if (remaining.length === 0) this.listeners.delete(event)
      else this.listeners.set(event, remaining)
    }
    for (const [name, entries] of this.filters) {
      const remaining = entries.filter((entry) => entry.pluginId !== pluginId)
      if (remaining.length === 0) this.filters.delete(name)
      else this.filters.set(name, remaining)
    }
  }

  /**
   * Fire an event. Listeners run sequentially; an error in one listener is
   * logged and does not stop the others. Returns when every listener has
   * resolved or rejected.
   *
   * The name type is the enforcement that `CORE_HOOK_EVENTS` cannot drift:
   * host emit sites must use a listed core name, and everything else must
   * already be plugin-namespaced (the output of `canonicalPluginEventName`).
   */
  async emit(event: CoreHookEvent | PluginScopedHookEvent, payload: unknown): Promise<void> {
    const entries = this.listeners.get(event)
    if (!entries) return
    for (const entry of entries) {
      try {
        await entry.listener(payload)
      } catch (err) {
        console.error(`[plugin:${entry.pluginId}] listener for "${event}" threw:`, err)
      }
    }
  }

  /**
   * Run a value through every registered handler for a filter pipeline.
   * Each handler receives the previous handler's output and the context
   * merged from `{ pluginId }` + the optional `contextExtras`. Errors are
   * logged and the value is left unchanged.
   *
   * @param contextExtras  Additional context fields forwarded to every
   *   handler alongside `{ pluginId }`. Used by `publish.html` and
   *   `publish.headers` to pass `{ siteId, pageId, slug }`.
   */
  async applyFilter<T>(
    name: string,
    value: T,
    contextExtras?: Record<string, unknown>,
  ): Promise<T> {
    const entries = this.filters.get(name)
    if (!entries) return value
    let current = value as unknown
    for (const entry of entries) {
      try {
        const context = contextExtras
          ? { pluginId: entry.pluginId, ...contextExtras }
          : { pluginId: entry.pluginId }
        const next = await entry.handler(current, context)
        current = next
      } catch (err) {
        console.error(`[plugin:${entry.pluginId}] filter "${name}" threw:`, err)
      }
    }
    return current as T
  }

  hasListenersFor(event: string): boolean {
    return (this.listeners.get(event)?.length ?? 0) > 0
  }

  hasFiltersFor(name: string): boolean {
    return (this.filters.get(name)?.length ?? 0) > 0
  }

  // Test-only introspection
  __debug__(): { events: string[]; filters: string[] } {
    return {
      events: [...this.listeners.keys()],
      filters: [...this.filters.keys()],
    }
  }
}

export const hookBus = new HookBus()
