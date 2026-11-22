// ---------------------------------------------------------------------------
// CMS server-side hook event surface
// ---------------------------------------------------------------------------

import type { PluginMailFailureReason, PluginMailRecipient } from './mail'

/**
 * Actor that originated a content mutation. Carried on every
 * `content.entry.*` event so listeners can filter their own writes
 * (avoid feedback loops).
 *
 *   - `user`   — an admin user driving an HTTP request through the host
 *                CMS handlers.
 *   - `plugin` — a plugin acting via `api.cms.content.*`; the host fills
 *                in the plugin's id from the dispatcher context.
 *   - `system` — unattended server paths (e.g. public form submissions and
 *                the publish-scheduler tick once `scheduled_publish_at` is
 *                in the past).
 */
export type ContentEntryActor =
  | { kind: 'user'; userId: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'system' }

/**
 * Host events and their payloads.
 *
 * `cms.hooks` lets a plugin use the hook bus; an event that carries guarded
 * data needs that data's permission as well, and a registration the plugin
 * could never be served throws (`server/plugins/protocol/hookRules.ts`):
 *
 *   - `content.entry.*` — `cms.content.read` and a `contentAccess` entry with
 *     `read`. The plugin hears about entries of the tables it may read, and
 *     no others.
 *   - `member.*` — `members.read`.
 *   - `mail.*` — only the plugin that queued the email.
 *
 * A name the host does not emit is refused, unless it is another plugin's
 * event (`plugin.<its-id>.<name>`).
 */
export interface CmsServerEvents {
  // This plugin's own settings were saved, from the admin form or by its own
  // `api.cms.settings.replace`. Only the plugin that owns the settings hears
  // it. The payload carries no values: read them with
  // `api.cms.settings.get(...)`, which already returns the new ones.
  'settings.changed': { pluginId: string }
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
  // Site member events. Listening needs `members.read`. They are sent
  // without waiting: a listener cannot delay or cancel what happened.
  'member.created': { memberId: string; email: string }
  'member.verified': { memberId: string; email: string }
  'member.signedIn': { memberId: string; email: string }
  'member.tagged': { memberId: string; tag: string; source: string; expiresAt: string | null }
  'member.deleted': { memberId: string }
  // What became of an email this plugin queued. Only the plugin that sent it
  // hears about it. `to` is the recipient as the plugin named it (a member's
  // address is never handed back); `reference` is the one given to
  // `api.cms.mail.send`; `reason` is a fixed code, never the provider's text.
  'mail.delivered': { template: string; to: PluginMailRecipient; reference: string | null }
  'mail.failed': {
    template: string
    to: PluginMailRecipient
    reference: string | null
    reason: PluginMailFailureReason
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

/**
 * The filters the host applies. There are no plugin-defined filters: a name
 * not listed here is refused at registration.
 */
export interface CmsServerFilters {
  /**
   * A public page as it is sent. A members-only page rendered for a member
   * reaches the filter only if the plugin holds `members.read`. A preview of
   * unpublished work (a draft entry, a branch) is never passed to it.
   */
  'publish.html': string
  /**
   * An entry's cells, run through each handler before they are saved; what
   * the handler returns is persisted. Needs `cms.content.read` and
   * `cms.content.write` with a `contentAccess` entry granting both on the
   * entry's table: the handler runs for those tables only. The context
   * carries the table slug, entry id (or `'new'` for create), and the actor.
   */
  'content.entry.cells': Record<string, unknown>
}

/**
 * Extra context fields passed to filter handlers alongside `{ pluginId }`.
 * Keyed by filter name.
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
  'content.entry.cells': {
    tableSlug: string
    entryId: string
    actor: ContentEntryActor
    /**
     * True when the row is being saved on a branch, not on the live site.
     * `entryId` then names the branch's copy: `api.cms.content.*` reads and
     * writes `main`, so do not write back by that id.
     */
    branch: boolean
  }
}

export interface ServerPluginHooksApi {
  on: <K extends keyof CmsServerEvents | string>(
    event: K,
    listener: (
      payload: K extends keyof CmsServerEvents ? CmsServerEvents[K] : Record<string, unknown>,
    ) => void | Promise<void>,
  ) => void
  filter: <K extends keyof CmsServerFilters>(
    name: K,
    handler: (
      value: CmsServerFilters[K],
      context: { pluginId: string } & CmsServerFilterContexts[K],
    ) => CmsServerFilters[K] | Promise<CmsServerFilters[K]>,
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
