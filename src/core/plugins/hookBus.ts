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
 * Event-name provenance: only the HOST emits the reserved core events
 * (`HostEventName`). Plugin-emitted events (via `cms.hooks.emit`) are
 * force-namespaced to `plugin.<pluginId>.<name>` through
 * `canonicalPluginEventName` before they reach `emit`, so a plugin can never
 * forge a core event or impersonate another plugin.
 *
 * Two ways to send, by who may hear:
 *   • `emit` — the listening plugins, all of them or those a recipient check
 *     accepts. For `BroadcastHookEvent` names and plugin-namespaced events.
 *   • `emitTo` — one plugin. The only way to send an `OwnerOnlyHookEvent`,
 *     news about one plugin's own business (its settings, its email). `emit`
 *     refuses those names at compile time and at run time, so a broadcast of
 *     one cannot be written by accident.
 *
 * What a plugin needs in order to LISTEN to each host event is one table,
 * `HOST_EVENT_RULES` in `server/plugins/protocol/hookRules.ts`, keyed by
 * `HostEventName`: a name added here does not compile until its rule is
 * written.
 */

/**
 * Host events sent with `emit`. Plugins cannot emit them: plugin emits are
 * always canonicalized into the `plugin.<pluginId>.*` namespace.
 */
type BroadcastHookEvent = GuardedHostEvent | PublishHookEvent

/**
 * Host events whose payload another permission guards (a table's entries,
 * site members). `emit` REQUIRES a recipient check for these by type: there
 * is no way to send one to every listener, not through an alias of the bus
 * and not by passing `undefined`. Must list exactly the names whose rule in
 * `HOST_EVENT_RULES` is per table or per permission (checked there).
 */
export type GuardedHostEvent =
  | 'content.entry.created'
  | 'content.entry.updated'
  | 'content.entry.deleted'
  | MemberHookEvent

/**
 * The same names at run time. The overloads stop a guarded send without
 * recipients where the bus is used through its own type; a value typed more
 * loosely (`{ emit(event: string, …) }`) gets past them, so `emit` and
 * `applyFilter` check again when they run and refuse.
 */
const GUARDED_HOST_EVENTS: ReadonlySet<string> = new Set<GuardedHostEvent>([
  'content.entry.created',
  'content.entry.updated',
  'content.entry.deleted',
  'member.created',
  'member.verified',
  'member.signedIn',
  'member.tagged',
  'member.deleted',
])
const PUBLISH_HOOK_EVENTS: ReadonlySet<string> = new Set<PublishHookEvent>(['publish.before', 'publish.after'])

/** Refuse a send that does not say who it is for, when the name requires it. */
function assertRecipientsNamed(
  what: string,
  name: string,
  recipients: HookRecipientCheck | EveryRecipient | undefined,
  need: 'check' | 'check-or-everyone',
): void {
  if (typeof recipients === 'function') return
  if (need === 'check-or-everyone' && recipients === 'everyone') return
  throw new Error(
    need === 'check'
      ? `[hookBus] ${what} "${name}" carries guarded data: it must be sent with a recipient check.`
      : `[hookBus] ${what} "${name}" must say who it is for: a recipient check, or 'everyone'.`,
  )
}

/**
 * A page was rendered. Who hears it depends on who the render is for, so the
 * sender must say: a recipient check, or `'everyone'` for a public page.
 */
export type PublishHookEvent = 'publish.before' | 'publish.after'

/**
 * Site member events. Their payloads name members, so only a plugin holding
 * `members.read` may listen (`HOST_EVENT_RULES`).
 */
export type MemberHookEvent =
  | 'member.created'
  | 'member.verified'
  | 'member.signedIn'
  | 'member.tagged'
  | 'member.deleted'

/**
 * What became of an email a plugin queued. Sent with `emitTo`, so only the
 * plugin that queued the email hears it.
 */
export type MailHookEvent = 'mail.delivered' | 'mail.failed'

/**
 * Host events about one plugin's own business. Only that plugin hears them:
 * they go out through `emitTo`, never `emit`. `settings.changed` tells a
 * plugin its own settings were saved; another plugin has no right to know
 * that, let alone to see the values.
 */
export const OWNER_ONLY_HOOK_EVENTS = ['settings.changed', 'mail.delivered', 'mail.failed'] as const
type OwnerOnlyHookEvent = (typeof OWNER_ONLY_HOOK_EVENTS)[number]

function isOwnerOnlyHookEvent(event: string): event is OwnerOnlyHookEvent {
  return (OWNER_ONLY_HOOK_EVENTS as readonly string[]).includes(event)
}

/**
 * The only keys an owner-only payload may carry. `emitTo` refuses anything
 * else, so a settings record (or any other value) cannot ride along.
 */
const OWNER_ONLY_PAYLOAD_KEYS: Record<OwnerOnlyHookEvent, readonly string[]> = {
  'settings.changed': ['pluginId'],
  'mail.delivered': ['template', 'to', 'reference'],
  'mail.failed': ['template', 'to', 'reference', 'reason'],
}

function assertOwnerOnlyPayload(pluginId: string, event: OwnerOnlyHookEvent, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`[hookBus] "${event}" payload must be an object.`)
  }
  const allowed = OWNER_ONLY_PAYLOAD_KEYS[event]
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key))
  if (extra.length > 0) {
    throw new Error(`[hookBus] "${event}" payload may not carry: ${extra.join(', ')}.`)
  }
  if (event === 'settings.changed' && (payload as { pluginId?: unknown }).pluginId !== pluginId) {
    throw new Error(`[hookBus] "settings.changed" names plugin "${pluginId}" and goes to it alone.`)
  }
}

/** Every reserved host event name, however it is sent. */
export type HostEventName = BroadcastHookEvent | OwnerOnlyHookEvent

/**
 * Every filter pipeline the host applies. What a plugin needs in order to
 * register a handler for each is `HOST_FILTER_RULES` in
 * `server/plugins/protocol/hookRules.ts`, keyed by this union.
 */
export type HostFilterName = 'publish.html' | 'content.entry.cells' | 'media.url.transform'

/** Decides, per plugin, whether one send or one filter run is for it. */
export type HookRecipientCheck = (pluginId: string) => boolean

/** The explicit way to say a send is for every registered plugin. */
export type EveryRecipient = 'everyone'

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

function runtimeValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
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

  filter(pluginId: string, name: HostFilterName, handler: HookFilterHandler): void {
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
   * Fire an event for one plugin only: news about that plugin's own business
   * (its settings were saved, an email it queued was delivered). No other
   * plugin's listener runs, and the payload may carry only the keys listed
   * for the event: `settings.changed` names the plugin and nothing more.
   */
  async emitTo(pluginId: string, event: OwnerOnlyHookEvent, payload: unknown): Promise<void> {
    assertOwnerOnlyPayload(pluginId, event, payload)
    for (const entry of this.listeners.get(event) ?? []) {
      if (entry.pluginId !== pluginId) continue
      try {
        await entry.listener(payload)
      } catch (err) {
        console.error(`[plugin:${entry.pluginId}] listener for "${event}" threw:`, err)
      }
    }
  }

  /**
   * Fire an event for every listening plugin. Listeners run sequentially; an
   * error in one listener is logged and does not stop the others. Returns
   * when every listener has resolved or rejected.
   *
   * The name type keeps host emit sites to the listed broadcast names;
   * everything else must already be plugin-namespaced (the output of
   * `canonicalPluginEventName`). An owner-only event is refused outright,
   * also at run time: a cast must not be enough to broadcast one.
   *
   * Recipients, by the kind of name (the overloads below):
   *   - a guarded host event: a recipient check, always;
   *   - a publish event: a recipient check, or `'everyone'`;
   *   - a plugin's own event (`plugin.*`): every listener, no argument.
   */
  async emit(event: GuardedHostEvent, payload: unknown, mayReceive: HookRecipientCheck): Promise<void>
  async emit(event: PublishHookEvent, payload: unknown, recipients: HookRecipientCheck | EveryRecipient): Promise<void>
  async emit(event: PluginScopedHookEvent, payload: unknown): Promise<void>
  async emit(
    event: BroadcastHookEvent | PluginScopedHookEvent,
    payload: unknown,
    recipients?: HookRecipientCheck | EveryRecipient,
  ): Promise<void> {
    if (isOwnerOnlyHookEvent(event)) {
      throw new Error(`[hookBus] "${event}" is for one plugin only: send it with emitTo(pluginId, …).`)
    }
    if (GUARDED_HOST_EVENTS.has(event)) assertRecipientsNamed('event', event, recipients, 'check')
    else if (PUBLISH_HOOK_EVENTS.has(event)) assertRecipientsNamed('event', event, recipients, 'check-or-everyone')
    const mayReceive = typeof recipients === 'function' ? recipients : null
    const entries = this.listeners.get(event)
    if (!entries) return
    for (const entry of entries) {
      if (mayReceive && !mayReceive(entry.pluginId)) continue
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
   * merged from `{ pluginId }` + the optional `contextExtras`. Errors and
   * results of a different runtime type are logged and leave the value
   * unchanged.
   *
   * @param contextExtras  Additional context fields forwarded to every
   *   handler alongside `{ pluginId }`. Used by `publish.html` to pass
   *   `{ siteId, pageId, slug }`.
   * Recipients, by filter (the overloads below): the entry cells filter takes
   * a recipient check, always; the HTML filter a recipient check or
   * `'everyone'`; the media URL chain has its own registration and runs for
   * every registered transformer.
   */
  async applyFilter<T>(
    name: 'content.entry.cells',
    value: T,
    contextExtras: Record<string, unknown>,
    mayReceive: HookRecipientCheck,
  ): Promise<T>
  async applyFilter<T>(
    name: 'publish.html',
    value: T,
    contextExtras: Record<string, unknown>,
    recipients: HookRecipientCheck | EveryRecipient,
  ): Promise<T>
  async applyFilter<T>(name: 'media.url.transform', value: T): Promise<T>
  async applyFilter<T>(
    name: HostFilterName,
    value: T,
    contextExtras?: Record<string, unknown>,
    recipients?: HookRecipientCheck | EveryRecipient,
  ): Promise<T> {
    if (name === 'content.entry.cells') assertRecipientsNamed('filter', name, recipients, 'check')
    else if (name === 'publish.html') assertRecipientsNamed('filter', name, recipients, 'check-or-everyone')
    const mayReceive = typeof recipients === 'function' ? recipients : null
    const entries = this.filters.get(name)
    if (!entries) return value
    let current = value as unknown
    for (const entry of entries) {
      if (mayReceive && !mayReceive(entry.pluginId)) continue
      try {
        const context = contextExtras
          ? { pluginId: entry.pluginId, ...contextExtras }
          : { pluginId: entry.pluginId }
        const next = await entry.handler(current, context)
        if (runtimeValueType(next) !== runtimeValueType(current)) {
          console.error(
            `[plugin:${entry.pluginId}] filter "${name}" returned a different value type; keeping the previous value.`,
          )
          continue
        }
        current = next
      } catch (err) {
        console.error(`[plugin:${entry.pluginId}] filter "${name}" threw:`, err)
      }
    }
    return current as T
  }

  /** Whether this plugin is listening for `event` right now. */
  hasListener(pluginId: string, event: string): boolean {
    return (this.listeners.get(event) ?? []).some((entry) => entry.pluginId === pluginId)
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
