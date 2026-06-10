// ---------------------------------------------------------------------------
// CMS server-side hook event surface
// ---------------------------------------------------------------------------

/**
 * Actor that originated a content mutation. Carried on every
 * `content.entry.*` event so listeners can filter their own writes
 * (avoid feedback loops).
 *
 *   - `user`   — an admin user driving an HTTP request through the host
 *                CMS handlers.
 *   - `plugin` — a plugin acting via `api.cms.content.*`; the host fills
 *                in the plugin's id from the dispatcher context.
 *   - `system` — schedulers and other unattended jobs (e.g. the
 *                publish-scheduler tick once `scheduled_publish_at` is in
 *                the past).
 */
export type ContentEntryActor =
  | { kind: 'user'; userId: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'system' }

export interface CmsServerEvents {
  'publish.before': { siteId: string; pageId?: string }
  'publish.after': { siteId: string; pageId?: string }
  'content.entry.created': {
    tableSlug: string
    entryId: string
    actor: ContentEntryActor
  }
  'content.entry.updated': {
    tableSlug: string
    entryId: string
    changedFieldIds: string[]
    actor: ContentEntryActor
  }
  'content.entry.deleted': {
    tableSlug: string
    entryId: string
    actor: ContentEntryActor
  }
  // Plugin-defined events fall through. The host does not pre-define any
  // frontend-specific event channels — plugins that ingest events from
  // their own published-page bundles register their own `routes.public.post`
  // endpoints and (optionally) re-emit on the hook bus for cross-plugin
  // coordination. Plugin emits are always namespaced by the host, so the
  // name other plugins subscribe to is `plugin.<emitter-id>.<name>` (e.g.
  // `plugin.instatic.analytics.page-view`).
  [key: string]: Record<string, unknown>
}

export interface CmsServerFilters {
  'publish.html': string
  'publish.headers': Record<string, string>
  /**
   * Cell-bag run through every registered handler before persistence.
   * Plugins can validate, normalize, or auto-fill — e.g. extract a meta
   * description from a body field. The context carries the table slug,
   * entry id (or `'new'` for create), and the actor.
   */
  'content.entry.cells': Record<string, unknown>
  // Plugin-defined filters fall through.
  [key: string]: unknown
}

/**
 * Extra context fields passed to filter handlers alongside `{ pluginId }`.
 * Keyed by filter name; only named filters carry structured context — the
 * generic fallthrough gets `Record<string, unknown>`.
 *
 * Filter handlers destructure what they need:
 * ```ts
 * api.cms.hooks.filter('publish.html', (html, { siteId, pageId, slug }) => {
 *   return html.replace('</body>', `<!-- page:${slug} -->\n</body>`)
 * })
 * ```
 */
export interface CmsServerFilterContexts {
  'publish.html': { siteId: string; pageId: string; slug: string }
  'publish.headers': { siteId: string; pageId: string; slug: string }
  'content.entry.cells': {
    tableSlug: string
    entryId: string
    actor: ContentEntryActor
  }
}

export interface ServerPluginHooksApi {
  on: <K extends keyof CmsServerEvents | string>(
    event: K,
    listener: (
      payload: K extends keyof CmsServerEvents ? CmsServerEvents[K] : Record<string, unknown>,
    ) => void | Promise<void>,
  ) => void
  filter: <K extends keyof CmsServerFilters | string>(
    name: K,
    handler: (
      value: K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown,
      context: { pluginId: string } & (
        K extends keyof CmsServerFilterContexts ? CmsServerFilterContexts[K] : Record<string, unknown>
      ),
    ) =>
      | (K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown)
      | Promise<K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown>,
  ) => void
  /**
   * Emit a custom event on the hook bus. The host force-namespaces the name
   * to the emitting plugin: `emit('sync.done', …)` is delivered as
   * `plugin.<your-id>.sync.done`. A name already in your own namespace
   * passes through unchanged; a name in another plugin's namespace
   * (`plugin.<other-id>.*`) is rejected. Core host events (`publish.*`,
   * `content.entry.*`, `settings.changed`) therefore cannot be forged —
   * emitting one just yields `plugin.<your-id>.<name>`.
   *
   * Resolves to the canonical (namespaced) event name — the exact string
   * other plugins must pass to `on()` to receive your events.
   */
  emit: (event: string, payload: unknown) => Promise<string>
}
